#!/usr/bin/env tsx

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildShadowPositionLedger,
  type ShadowFillInput
} from "../packages/data/src/shadowPositionLedger";
import {
  boolArg,
  discoverDbPath,
  numberArg,
  openReadOnlyDatabase,
  parseCliArgs,
  resolveRepoRoot,
  safeClose,
  stringArg,
  tableExists,
  type SqliteDb
} from "./lib/db.js";

type VerificationRealismConfig = {
  enforcement: "warn" | "hard";
  makerRealFillRateMin: number;
  makerRealFillsPerDayMin: number;
  takerCloseRatioMin: number;
  takerOneSidedMax: number;
  requireRuntimeLiveness: boolean;
};

type CommandResult = {
  name: string;
  required: boolean;
  command: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
};

type LaneDecisionSummary = {
  lane: string;
  total: number;
  submitCount: number;
  skipCount: number;
};

type KindCount = {
  kind: string;
  count: number;
};

type HorizonMarkoutSummary = {
  horizonMs: number;
  count: number;
  avgBps: number | null;
};

type WalletFillSummary = {
  walletId: number | null;
  fills: number;
};

type EvidenceMetrics = {
  windowHours: number;
  trades15m: number;
  tradesWindow: number;
  activeTokens15m: number;
  activeTokensWindow: number;
  laneDecisions: LaneDecisionSummary[];
  orderCountsByKind: KindCount[];
  fillCountsByKind: KindCount[];
  markouts: HorizonMarkoutSummary[];
  makerOrdersShadow: number;
  makerRealFillsShadow: number;
  makerFillRateShadow: number;
  takerOpenedCycles: number;
  takerClosedCycles: number;
  takerCloseRatio: number;
  takerOneSidedRatio: number;
  walletFillDistribution: WalletFillSummary[];
};

type EvidenceReport = {
  generatedAtIso: string;
  dbPath: string;
  phase: "burn-in" | "frozen";
  strict: boolean;
  verificationRealism: VerificationRealismConfig;
  metrics: EvidenceMetrics;
  checks: CommandResult[];
  verdict: {
    coreHealthy: boolean;
    realismHealthy: boolean;
    promotionReady: boolean;
    pass: boolean;
    notes: string[];
  };
};

type TradeFlowCountRow = { c: number };
type LaneDecisionRow = { lane: string | null; total: number; submitCount: number; skipCount: number };
type KindCountRow = { kind: string; c: number };
type MarkoutRow = { horizonMs: number; c: number; avgBps: number | null };
type WalletFillRow = { walletId: number | null; fills: number };
type TakerFillRow = {
  walletId: number;
  tokenId: string;
  side: string;
  price: number;
  size: number;
  ts: number;
};

function tail(text: string, lines = 18): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const all = trimmed.split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

function toRunId(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function toAbs(repoRoot: string, maybeRel: string): string {
  return path.isAbsolute(maybeRel) ? maybeRel : path.join(repoRoot, maybeRel);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function readVerificationRealismConfig(repoRoot: string, configPathArg: string): VerificationRealismConfig {
  const defaults: VerificationRealismConfig = {
    enforcement: "warn",
    makerRealFillRateMin: 0.02,
    makerRealFillsPerDayMin: 20,
    takerCloseRatioMin: 0.15,
    takerOneSidedMax: 0.85,
    requireRuntimeLiveness: true
  };
  const configPath = toAbs(repoRoot, configPathArg);
  if (!existsSync(configPath)) {
    return defaults;
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
      realism?: Partial<VerificationRealismConfig>;
    };
    const realism = parsed.realism ?? {};
    return {
      enforcement: realism.enforcement === "hard" ? "hard" : "warn",
      makerRealFillRateMin: Number.isFinite(realism.makerRealFillRateMin)
        ? Math.max(0, Number(realism.makerRealFillRateMin))
        : defaults.makerRealFillRateMin,
      makerRealFillsPerDayMin: Number.isFinite(realism.makerRealFillsPerDayMin)
        ? Math.max(0, Number(realism.makerRealFillsPerDayMin))
        : defaults.makerRealFillsPerDayMin,
      takerCloseRatioMin: Number.isFinite(realism.takerCloseRatioMin)
        ? clamp01(Number(realism.takerCloseRatioMin))
        : defaults.takerCloseRatioMin,
      takerOneSidedMax: Number.isFinite(realism.takerOneSidedMax)
        ? clamp01(Number(realism.takerOneSidedMax))
        : defaults.takerOneSidedMax,
      requireRuntimeLiveness: typeof realism.requireRuntimeLiveness === "boolean"
        ? realism.requireRuntimeLiveness
        : defaults.requireRuntimeLiveness
    };
  } catch {
    return defaults;
  }
}

function runCommand(repoRoot: string, opts: {
  name: string;
  required: boolean;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}): CommandResult {
  const started = Date.now();
  const proc = spawnSync(opts.command, opts.args, {
    cwd: repoRoot,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: "utf-8",
    timeout: opts.timeoutMs
  });
  const output = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
  return {
    name: opts.name,
    required: opts.required,
    command: [opts.command, ...opts.args].join(" "),
    passed: proc.status === 0,
    exitCode: proc.status ?? null,
    durationMs: Date.now() - started,
    outputTail: tail(output)
  };
}

function collectMetrics(sqlite: SqliteDb, windowHours: number): EvidenceMetrics {
  const now = Date.now();
  const sinceWindow = now - windowHours * 60 * 60 * 1000;
  const since15m = now - 15 * 60 * 1000;

  const trades15m = (
    sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM clob_events
         WHERE msg_type = 'trade'
           AND recv_ts_ms >= ?`
      )
      .get(since15m) as TradeFlowCountRow
  ).c;

  const tradesWindow = (
    sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM clob_events
         WHERE msg_type = 'trade'
           AND recv_ts_ms >= ?`
      )
      .get(sinceWindow) as TradeFlowCountRow
  ).c;

  const activeTokens15m = (
    sqlite
      .prepare(
        `SELECT COUNT(DISTINCT token_id) as c
         FROM clob_events
         WHERE msg_type = 'trade'
           AND recv_ts_ms >= ?`
      )
      .get(since15m) as TradeFlowCountRow
  ).c;

  const activeTokensWindow = (
    sqlite
      .prepare(
        `SELECT COUNT(DISTINCT token_id) as c
         FROM clob_events
         WHERE msg_type = 'trade'
           AND recv_ts_ms >= ?`
      )
      .get(sinceWindow) as TradeFlowCountRow
  ).c;

  const laneRows = sqlite
    .prepare(
      `SELECT
         strategy_lane as lane,
         COUNT(*) as total,
         COALESCE(SUM(CASE WHEN decision = 'SUBMIT' THEN 1 ELSE 0 END), 0) as submitCount,
         COALESCE(SUM(CASE WHEN decision = 'SKIP' THEN 1 ELSE 0 END), 0) as skipCount
       FROM decision_log
       WHERE ts >= ?
       GROUP BY strategy_lane
       ORDER BY total DESC`
    )
    .all(sinceWindow) as LaneDecisionRow[];

  const laneDecisions: LaneDecisionSummary[] = laneRows.map((row) => ({
    lane: row.lane ?? "UNKNOWN",
    total: row.total,
    submitCount: row.submitCount,
    skipCount: row.skipCount
  }));

  const orderCountsByKind = (
    sqlite
      .prepare(
        `SELECT kind, COUNT(*) as c
         FROM shadow_orders
         WHERE ts >= ?
         GROUP BY kind
         ORDER BY c DESC`
      )
      .all(sinceWindow) as KindCountRow[]
  ).map((row) => ({ kind: row.kind, count: row.c }));

  const fillCountsByKind = (
    sqlite
      .prepare(
        `SELECT o.kind as kind, COUNT(*) as c
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE f.ts >= ?
         GROUP BY o.kind
         ORDER BY c DESC`
      )
      .all(sinceWindow) as KindCountRow[]
  ).map((row) => ({ kind: row.kind, count: row.c }));

  const markouts = (
    sqlite
      .prepare(
        `SELECT horizon_ms as horizonMs, COUNT(*) as c, AVG(markout_bps) as avgBps
         FROM shadow_markouts
         WHERE ts >= ?
         GROUP BY horizon_ms
         ORDER BY horizon_ms ASC`
      )
      .all(sinceWindow) as MarkoutRow[]
  ).map((row) => ({
    horizonMs: row.horizonMs,
    count: row.c,
    avgBps: Number.isFinite(row.avgBps) ? row.avgBps : null
  }));

  const makerOrdersShadow = (
    sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM shadow_orders
         WHERE ts >= ?
           AND execution_mode = 'SHADOW'
           AND kind IN ('MAKER_BID', 'MAKER_ASK')`
      )
      .get(sinceWindow) as TradeFlowCountRow
  ).c;

  const makerRealFillsShadow = (
    sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE f.ts >= ?
           AND (f.method IS NULL OR f.method != 'synthetic_fill')
           AND o.execution_mode = 'SHADOW'
           AND o.kind IN ('MAKER_BID', 'MAKER_ASK')`
      )
      .get(sinceWindow) as TradeFlowCountRow
  ).c;
  const makerFillRateShadow = makerOrdersShadow > 0 ? makerRealFillsShadow / makerOrdersShadow : 0;

  const takerRows = sqlite
    .prepare(
      `SELECT
         o.wallet_id as walletId,
         o.token_id as tokenId,
         o.side as side,
         f.price as price,
         f.size as size,
         f.ts as ts
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE f.ts >= ?
         AND o.kind IN ('TAKER_BUY', 'TAKER_SELL')
         AND (f.method IS NULL OR f.method != 'synthetic_fill')
       ORDER BY f.ts ASC`
    )
    .all(sinceWindow) as TakerFillRow[];

  const takerFills: ShadowFillInput[] = [];
  const sideByGroup = new Map<string, { buy: boolean; sell: boolean }>();
  for (const row of takerRows) {
    if (row.side !== "BUY" && row.side !== "SELL") continue;
    takerFills.push({
      walletId: row.walletId,
      tokenId: row.tokenId,
      side: row.side,
      price: row.price,
      size: row.size,
      ts: row.ts
    });
    const key = `${row.walletId}:${row.tokenId}`;
    const sides = sideByGroup.get(key) ?? { buy: false, sell: false };
    if (row.side === "BUY") sides.buy = true;
    if (row.side === "SELL") sides.sell = true;
    sideByGroup.set(key, sides);
  }
  const takerLedger = buildShadowPositionLedger(takerFills);
  let takerOpenedCycles = 0;
  let takerClosedCycles = 0;
  for (const state of takerLedger.values()) {
    takerOpenedCycles += state.openedCycles;
    takerClosedCycles += state.closedCycles;
  }
  const takerCloseRatio = takerOpenedCycles > 0 ? takerClosedCycles / takerOpenedCycles : 0;

  let activeGroups = 0;
  let oneSidedGroups = 0;
  for (const sides of sideByGroup.values()) {
    if (!sides.buy && !sides.sell) continue;
    activeGroups += 1;
    if (sides.buy !== sides.sell) oneSidedGroups += 1;
  }
  const takerOneSidedRatio = activeGroups > 0 ? oneSidedGroups / activeGroups : 0;

  const walletFillDistribution = (
    sqlite
      .prepare(
        `SELECT
           o.wallet_id as walletId,
           COUNT(*) as fills
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE f.ts >= ?
           AND (f.method IS NULL OR f.method != 'synthetic_fill')
         GROUP BY o.wallet_id
         ORDER BY fills DESC
         LIMIT 20`
      )
      .all(sinceWindow) as WalletFillRow[]
  ).map((row) => ({ walletId: row.walletId, fills: row.fills }));

  return {
    windowHours,
    trades15m,
    tradesWindow,
    activeTokens15m,
    activeTokensWindow,
    laneDecisions,
    orderCountsByKind,
    fillCountsByKind,
    markouts,
    makerOrdersShadow,
    makerRealFillsShadow,
    makerFillRateShadow,
    takerOpenedCycles,
    takerClosedCycles,
    takerCloseRatio,
    takerOneSidedRatio,
    walletFillDistribution
  };
}

function toMarkdown(report: EvidenceReport): string {
  const failedRequired = report.checks.filter((c) => c.required && !c.passed);
  const fmtPct = (v: number): string => `${(v * 100).toFixed(2)}%`;

  const checkLines = report.checks.map((check) => {
    const status = check.passed ? "PASS" : "FAIL";
    const required = check.required ? "required" : "advisory";
    return `- [${status}] ${check.name} (${required}, ${check.durationMs}ms, exit=${check.exitCode ?? "null"})`;
  });

  const laneLines = report.metrics.laneDecisions.map(
    (row) => `- ${row.lane}: total=${row.total}, submit=${row.submitCount}, skip=${row.skipCount}`
  );
  const walletLines = report.metrics.walletFillDistribution.map(
    (row) => `- wallet=${row.walletId ?? "null"} fills=${row.fills}`
  );

  const notes = report.verdict.notes.map((note) => `- ${note}`);

  return [
    `# Evidence Pack`,
    ``,
    `- generated_at: ${report.generatedAtIso}`,
    `- db_path: ${report.dbPath}`,
    `- phase: ${report.phase}`,
    `- strict: ${String(report.strict)}`,
    `- pass: ${String(report.verdict.pass)}`,
    `- core_healthy: ${String(report.verdict.coreHealthy)}`,
    `- realism_healthy: ${String(report.verdict.realismHealthy)}`,
    `- promotion_ready: ${String(report.verdict.promotionReady)}`,
    ``,
    `## Checks`,
    ...checkLines,
    ``,
    `## Metrics`,
    `- trades_15m: ${report.metrics.trades15m}`,
    `- trades_window: ${report.metrics.tradesWindow}`,
    `- active_tokens_15m: ${report.metrics.activeTokens15m}`,
    `- active_tokens_window: ${report.metrics.activeTokensWindow}`,
    `- maker_orders_shadow: ${report.metrics.makerOrdersShadow}`,
    `- maker_real_fills_shadow: ${report.metrics.makerRealFillsShadow}`,
    `- maker_fill_rate_shadow: ${fmtPct(report.metrics.makerFillRateShadow)}`,
    `- taker_opened_cycles: ${report.metrics.takerOpenedCycles}`,
    `- taker_closed_cycles: ${report.metrics.takerClosedCycles}`,
    `- taker_close_ratio: ${fmtPct(report.metrics.takerCloseRatio)}`,
    `- taker_one_sided_ratio: ${fmtPct(report.metrics.takerOneSidedRatio)}`,
    ``,
    `## Decisions By Lane`,
    ...(laneLines.length ? laneLines : ["- none"]),
    ``,
    `## Wallet Fill Distribution`,
    ...(walletLines.length ? walletLines : ["- none"]),
    ``,
    `## Notes`,
    ...(notes.length ? notes : [`- required_failures=${failedRequired.length}`]),
    ``
  ].join("\n");
}

function main(): void {
  const args = parseCliArgs();
  const repoRoot = resolveRepoRoot();
  const now = new Date();
  const runId = toRunId(now);

  const dbPath = discoverDbPath(stringArg(args, "db", ""));
  const phaseRaw = stringArg(args, "phase", "burn-in").toLowerCase();
  const phase: "burn-in" | "frozen" = phaseRaw === "frozen" ? "frozen" : "burn-in";
  const windowHours = Math.max(1, numberArg(args, "window-hours", 24));
  const strict = boolArg(args, "strict", true);
  const skipTests = boolArg(args, "skip-tests", true);
  const outBase = toAbs(repoRoot, stringArg(args, "out-dir", "reports/evidence"));
  const runDir = path.join(outBase, runId);
  mkdirSync(runDir, { recursive: true });

  const verificationConfigPath = stringArg(args, "verification-config", "configs/verification.json");
  const realismConfig = readVerificationRealismConfig(repoRoot, verificationConfigPath);
  const realismRequired = realismConfig.enforcement === "hard";

  const checks: CommandResult[] = [];

  checks.push(
    runCommand(repoRoot, {
      name: "Invariant: no signal schema",
      required: true,
      command: "npx",
      args: ["tsx", "scripts/invariants/no-signal-schema.ts", "--db", dbPath],
      timeoutMs: 120_000
    })
  );
  checks.push(
    runCommand(repoRoot, {
      name: "Invariant: decision chain integrity",
      required: true,
      command: "npx",
      args: ["tsx", "scripts/invariants/decision-chain-integrity.ts", "--db", dbPath],
      timeoutMs: 240_000
    })
  );
  checks.push(
    runCommand(repoRoot, {
      name: "Invariant: decisionedge contract",
      required: false,
      command: "npx",
      args: ["tsx", "scripts/invariants/decisionedge-contract.ts", "--db", dbPath, "--window-min", "60"],
      timeoutMs: 120_000
    })
  );
  checks.push(
    runCommand(repoRoot, {
      name: "Invariant: decision log append-only",
      required: true,
      command: "npx",
      args: [
        "tsx",
        "scripts/invariants/decision-log-append-only.ts",
        "--db",
        dbPath,
        "--allow-empty-rebase"
      ],
      timeoutMs: 120_000
    })
  );

  checks.push(
    runCommand(repoRoot, {
      name: "Invariant: runtime liveness",
      required: realismRequired && realismConfig.requireRuntimeLiveness,
      command: "npx",
      args: ["tsx", "scripts/invariants/runtime-liveness.ts", "--db", dbPath, "--feed-max-age-sec", "120"],
      timeoutMs: 120_000
    })
  );
  checks.push(
    runCommand(repoRoot, {
      name: "Invariant: maker real fill activity",
      required: realismRequired,
      command: "npx",
      args: [
        "tsx",
        "scripts/invariants/maker-real-fill-activity.ts",
        "--db",
        dbPath,
        "--window-hours",
        String(windowHours),
        "--min-fill-rate",
        String(realismConfig.makerRealFillRateMin),
        "--min-real-fills",
        String(realismConfig.makerRealFillsPerDayMin)
      ],
      timeoutMs: 120_000
    })
  );
  checks.push(
    runCommand(repoRoot, {
      name: "Invariant: taker close balance",
      required: realismRequired,
      command: "npx",
      args: [
        "tsx",
        "scripts/invariants/taker-close-balance.ts",
        "--db",
        dbPath,
        "--window-hours",
        String(windowHours),
        "--min-close-ratio",
        String(realismConfig.takerCloseRatioMin),
        "--max-one-sided",
        String(realismConfig.takerOneSidedMax)
      ],
      timeoutMs: 120_000
    })
  );

  const goLiveArgs = [
    "tsx",
    "scripts/go-live-gate.ts",
    "--db",
    dbPath,
    "--phase",
    phase,
    "--skip-invariants",
    "--maker-real-fill-rate-min",
    String(realismConfig.makerRealFillRateMin),
    "--maker-real-fills-min",
    String(realismConfig.makerRealFillsPerDayMin),
    "--taker-close-ratio-min",
    String(realismConfig.takerCloseRatioMin),
    "--taker-one-sided-max",
    String(realismConfig.takerOneSidedMax)
  ];
  if (skipTests) {
    goLiveArgs.push("--skip-tests");
  }
  checks.push(
    runCommand(repoRoot, {
      name: "Go-live gate (advisory)",
      required: false,
      command: "npx",
      args: goLiveArgs,
      timeoutMs: 15 * 60_000
    })
  );

  let metrics: EvidenceMetrics = {
    windowHours,
    trades15m: 0,
    tradesWindow: 0,
    activeTokens15m: 0,
    activeTokensWindow: 0,
    laneDecisions: [],
    orderCountsByKind: [],
    fillCountsByKind: [],
    markouts: [],
    makerOrdersShadow: 0,
    makerRealFillsShadow: 0,
    makerFillRateShadow: 0,
    takerOpenedCycles: 0,
    takerClosedCycles: 0,
    takerCloseRatio: 0,
    takerOneSidedRatio: 0,
    walletFillDistribution: []
  };

  const metricsFailures: string[] = [];
  let sqlite: SqliteDb | null = null;
  try {
    sqlite = openReadOnlyDatabase(dbPath);
    const requiredTables = [
      "clob_events",
      "decision_log",
      "shadow_orders",
      "shadow_fills",
      "shadow_markouts"
    ];
    const missingTables = requiredTables.filter((name) => !tableExists(sqlite as SqliteDb, name));
    if (missingTables.length > 0) {
      metricsFailures.push(`missing tables for metrics: ${missingTables.join(", ")}`);
    } else {
      metrics = collectMetrics(sqlite as SqliteDb, windowHours);
    }
  } catch (err) {
    metricsFailures.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (sqlite) safeClose(sqlite);
  }

  const coreChecks = checks.filter((c) =>
    c.name.startsWith("Invariant: no signal schema") ||
    c.name.startsWith("Invariant: decision chain integrity") ||
    c.name.startsWith("Invariant: decision log append-only")
  );
  const coreHealthy = coreChecks.every((c) => c.passed);

  const realismChecks = checks.filter((c) =>
    c.name.startsWith("Invariant: runtime liveness") ||
    c.name.startsWith("Invariant: maker real fill activity") ||
    c.name.startsWith("Invariant: taker close balance")
  );
  const realismHealthy = realismChecks.every((c) => c.passed || !c.required);
  const promotionReady = checks.find((c) => c.name === "Go-live gate (advisory)")?.passed ?? false;

  const notes: string[] = [];
  const requiredFailures = checks.filter((c) => c.required && !c.passed);
  if (requiredFailures.length > 0) {
    notes.push(`required checks failing=${requiredFailures.length}`);
  }
  if (!promotionReady) {
    notes.push("promotion gate not ready yet");
  }
  if (metricsFailures.length > 0) {
    notes.push(...metricsFailures.map((m) => `metrics: ${m}`));
  }

  const pass = requiredFailures.length === 0;
  const report: EvidenceReport = {
    generatedAtIso: now.toISOString(),
    dbPath,
    phase,
    strict,
    verificationRealism: realismConfig,
    metrics,
    checks,
    verdict: {
      coreHealthy,
      realismHealthy,
      promotionReady,
      pass,
      notes
    }
  };

  const jsonPath = path.join(runDir, "summary.json");
  const mdPath = path.join(runDir, "summary.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  writeFileSync(mdPath, `${toMarkdown(report)}\n`, "utf-8");

  const latestJson = path.join(outBase, "latest.json");
  const latestMd = path.join(outBase, "latest.md");
  copyFileSync(jsonPath, latestJson);
  copyFileSync(mdPath, latestMd);

  console.log(`[evidence-pack] wrote ${jsonPath}`);
  console.log(`[evidence-pack] wrote ${mdPath}`);
  console.log(`[evidence-pack] updated ${latestJson}`);
  console.log(`[evidence-pack] updated ${latestMd}`);
  console.log(
    `[evidence-pack] verdict pass=${String(report.verdict.pass)} core=${String(report.verdict.coreHealthy)} realism=${String(report.verdict.realismHealthy)} promotion=${String(report.verdict.promotionReady)}`
  );

  if (strict && !pass) {
    process.exit(1);
  }
}

main();
