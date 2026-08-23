#!/usr/bin/env tsx
/**
 * Go-live gate: fail-fast checklist before routing real capital.
 *
 * This script is intentionally strict and should return non-zero whenever
 * promotion evidence is insufficient.
 *
 * Usage:
 *   npx tsx scripts/go-live-gate.ts
 *   npx tsx scripts/go-live-gate.ts --db data/dev.db --skip-tests
 */

import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildShadowPositionLedger,
  type ShadowFillInput
} from "../packages/data/src/shadowPositionLedger";
import {
  boolArg,
  numberArg,
  openReadOnlyDatabase,
  parseCliArgs,
  resolveRepoRoot,
  safeClose,
  stringArg,
  type SqliteDb
} from "./lib/db.js";

type GateResult = {
  name: string;
  required: boolean;
  passed: boolean;
  detail: string;
  evidence?: string;
};

type CmdGateOptions = {
  name: string;
  required?: boolean;
  command: string;
  args: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  verbose: boolean;
};

type DbCheckOptions = {
  minTrades15m: number;
  maxFeatureStaleSec: number;
  maxFeatureStaleRatio: number;
  minFreshRows5m: number;
  featureActiveWindowMin: number;
  takerWindowHours: number;
  maxTakerFillsPerOrder: number;
  maxSyntheticFillRatio: number;
  allowLiveFlags: boolean;
  requiredProfiles: string[];
  globalMinRealizedPnl: number;
  profileMinRealizedPnl: number;
  promotionDays: number;
  globalMinDecisions: number;
  globalMinFills: number;
  globalMinMarkouts: number;
  globalHorizonMs: number;
  lowerBoundZ: number;
  profileMinDecisions: number;
  profileMinFills: number;
  profileMinMarkouts: number;
  enforceRealism: boolean;
  makerRealFillRateMin: number;
  makerRealFillsMin: number;
  takerCloseRatioMin: number;
  takerOneSidedMax: number;
};

function printUsage(): void {
 console.log(`
Usage:
  pnpm go-live:gate
  pnpm go-live:gate -- --db data/dev.db

Options:
  --db <path>                         SQLite DB path (default: data/dev.db)
  --skip-tests                        Skip npm test gate (default: true)
  --test-script <name>                npm script for tests (default: test)
  --min-trades-15m <n>                Min recent trades for feed health (default: 50)
  --max-feature-stale-sec <n>         Feature stale threshold in seconds (default: 120)
  --max-feature-stale-ratio <f>       Max stale feature ratio [0,1] (default: 0.25)
  --min-fresh-rows-5m <n>             Min latest_features updated in last 5m (default: 10)
  --feature-active-window-min <n>     Active-token lookback window for staleness checks (default: 5)
  --taker-window-hours <n>            Window for taker/synthetic checks (default: 24)
  --max-taker-fills-per-order <f>     Max taker fill/order ratio (default: 1.1)
  --max-synthetic-fill-ratio <f>      Max synthetic fill ratio [0,1] (default: 0)
  --skip-invariants                   Skip invariant scripts gate
  --required-profiles <csv>           Required profiles that must pass (default: maker,taker)
  --global-min-realized-pnl <usd>     Min global realized PnL in promotion window (default: 0)
  --profile-min-realized-pnl <usd>    Min realized PnL per required profile (default: 0)
  --promotion-days <n>                Consecutive UTC days required for promotion window (default: 7)
  --global-min-decisions <n>          Min global SUBMIT decisions in promotion window (default: 200)
  --global-min-fills <n>              Min global fills in promotion window (default: 120)
  --global-min-markouts <n>           Min global markouts in promotion window (default: 120)
  --global-horizon-ms <ms>            Markout horizon for lower-bound checks (default: 300000)
  --lower-bound-z <z>                 One-sided z for lower bound (default: 1.6448536269514722)
  --profile-min-decisions <n>         Min SUBMIT decisions per profile (default: 50)
  --profile-min-fills <n>             Min fills per profile (default: 30)
  --profile-min-markouts <n>          Min markouts per profile (default: 30)
  --phase <burn-in|frozen>            Burn-in=warn realism checks, frozen=require realism checks (default: frozen)
  --maker-real-fill-rate-min <f>      Min maker real fill rate in taker-window (default: 0.02)
  --maker-real-fills-min <n>          Min maker real fills in taker-window (default: 20)
  --taker-close-ratio-min <f>         Min taker close ratio in taker-window (default: 0.15)
  --taker-one-sided-max <f>           Max one-sided taker group ratio (default: 0.85)
  --freeze-manifest <path>            Freeze manifest path (default: configs/freeze-manifest.json)
  --freeze-baseline <path>            Freeze baseline path (default: data/freeze/fingerprint.baseline.json)
  --allow-live-flags                  Do not fail if live flags/orders are present
  --verbose                           Print command output snippets for all command gates
  --help                              Show this help
`.trim());
}

function tail(text: string, lines = 14): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const all = trimmed.split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

function durationMs(startedAt: number): number {
  return Date.now() - startedAt;
}

function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function fmtUtcDay(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeProfile(value: string | null | undefined): string {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return "unknown";
  if (v.startsWith("maker")) return "maker";
  if (v.startsWith("taker")) return "taker";
  if (v.startsWith("arb")) return "arb";
  return v;
}

function parseProfileList(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const normalized = normalizeProfile(part);
    if (normalized === "unknown") continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function oneSidedLowerBound(mean: number | null, meanSq: number | null, n: number, z: number): number | null {
  if (!Number.isFinite(mean) || !Number.isFinite(meanSq) || n <= 0) return null;
  const mu = Number(mean);
  const second = Number(meanSq);
  const variance = Math.max(0, second - mu * mu);
  const se = Math.sqrt(variance / n);
  return mu - z * se;
}

function runCommandGate(options: CmdGateOptions): GateResult {
  const startedAt = Date.now();
  const result = spawnSync(options.command, options.args, {
    cwd: resolveRepoRoot(),
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf-8",
    timeout: options.timeoutMs
  });

  const elapsed = durationMs(startedAt);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = `${stdout}\n${stderr}`.trim();
  const passed = result.status === 0;
  const exitCode =
    result.status == null ? (result.signal ? `signal:${result.signal}` : "unknown") : String(result.status);
  const detail = `${options.command} ${options.args.join(" ")} (exit=${exitCode}, ${fmtSec(elapsed)})`;

  if (options.verbose || !passed) {
    const snippet = tail(output, passed ? 8 : 20);
    return {
      name: options.name,
      required: options.required ?? true,
      passed,
      detail,
      evidence: snippet || undefined
    };
  }

  return {
    name: options.name,
    required: options.required ?? true,
    passed,
    detail
  };
}

function tableExists(sqlite: SqliteDb, tableName: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function push(results: GateResult[], next: GateResult): void {
  results.push(next);
}

function runDbChecks(sqlite: SqliteDb, opts: DbCheckOptions): GateResult[] {
  const results: GateResult[] = [];
  const now = Date.now();
  const since15m = now - 15 * 60 * 1000;
  const since5m = now - 5 * 60 * 1000;
  const sinceFeatureActive = now - opts.featureActiveWindowMin * 60 * 1000;
  const sinceTaker = now - opts.takerWindowHours * 60 * 60 * 1000;

  const requiredTables = [
    "shadow_orders",
    "shadow_fills",
    "shadow_markouts",
    "latest_features",
    "clob_events",
    "decision_log",
    "settings"
  ];
  const missing = requiredTables.filter((tableName) => !tableExists(sqlite, tableName));
  push(results, {
    name: "DB schema prerequisites",
    required: true,
    passed: missing.length === 0,
    detail:
      missing.length === 0
        ? `All required tables present (${requiredTables.join(", ")})`
        : `Missing tables: ${missing.join(", ")}`
  });
  if (missing.length > 0) return results;

  const trades15mRow = sqlite
    .prepare(
      `SELECT COUNT(*) as c
       FROM clob_events
       WHERE msg_type = 'trade' AND recv_ts_ms >= ?`
    )
    .get(since15m) as { c: number } | undefined;
  const trades15m = trades15mRow?.c ?? 0;
  push(results, {
    name: "Recent trade flow (15m)",
    required: true,
    passed: trades15m >= opts.minTrades15m,
    detail: `trades_15m=${trades15m}, required>=${opts.minTrades15m}`
  });

  const featureFreshness = sqlite
    .prepare(
      `WITH active_tokens AS (
         SELECT DISTINCT token_id
         FROM clob_events
         WHERE recv_ts_ms >= ?
       ),
       active_features AS (
         SELECT lf.token_id, lf.staleness_sec, lf.ts
         FROM latest_features lf
         JOIN active_tokens at ON at.token_id = lf.token_id
       )
       SELECT
         (SELECT COUNT(*) FROM active_tokens) as active_tokens,
         COUNT(*) as feature_rows,
         COALESCE(SUM(CASE WHEN staleness_sec > ? AND ts < ? THEN 1 ELSE 0 END), 0) as stale_feature_rows,
         COALESCE(SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END), 0) as fresh_rows_5m
       FROM active_features`
    )
    .get(
      sinceFeatureActive,
      opts.maxFeatureStaleSec,
      now - opts.maxFeatureStaleSec * 1000,
      since5m
    ) as
      | {
          active_tokens: number;
          feature_rows: number;
          stale_feature_rows: number;
          fresh_rows_5m: number;
        }
      | undefined;
  const activeTokens = featureFreshness?.active_tokens ?? 0;
  const featureRows = featureFreshness?.feature_rows ?? 0;
  const missingRows = Math.max(0, activeTokens - featureRows);
  const staleRows = (featureFreshness?.stale_feature_rows ?? 0) + missingRows;
  const freshRows5m = featureFreshness?.fresh_rows_5m ?? 0;
  const totalRows = activeTokens;
  const staleRatio = totalRows > 0 ? staleRows / totalRows : 1;
  push(results, {
    name: "Feature staleness ratio",
    required: true,
    passed: totalRows > 0 && staleRatio <= opts.maxFeatureStaleRatio,
    detail:
      totalRows <= 0
        ? `no active tokens with CLOB events in last ${opts.featureActiveWindowMin}m`
        : `active_tokens=${activeTokens}, feature_rows=${featureRows}, stale=${staleRows}/${totalRows} (${fmtPct(staleRatio)}), max=${fmtPct(opts.maxFeatureStaleRatio)}, threshold_sec=${opts.maxFeatureStaleSec}, active_window_min=${opts.featureActiveWindowMin}`
  });
  push(results, {
    name: "Feature update recency (5m)",
    required: true,
    passed: freshRows5m >= opts.minFreshRows5m,
    detail: `fresh_rows_5m=${freshRows5m}, required>=${opts.minFreshRows5m}`
  });

  const takerOrderFill = sqlite
    .prepare(
      `SELECT
         COUNT(DISTINCT o.id) as orders,
         COUNT(f.id) as fills
       FROM shadow_orders o
       LEFT JOIN shadow_fills f ON f.order_id = o.id
       WHERE o.kind IN ('TAKER_BUY', 'TAKER_SELL')
         AND o.execution_mode = 'SHADOW'
         AND o.ts >= ?`
    )
    .get(sinceTaker) as { orders: number; fills: number } | undefined;
  const takerOrders = takerOrderFill?.orders ?? 0;
  const takerFills = takerOrderFill?.fills ?? 0;
  const takerFillsPerOrder = takerOrders > 0 ? takerFills / takerOrders : 0;
  push(results, {
    name: "Taker fill multiplicity",
    required: false,
    passed: takerOrders === 0 || takerFillsPerOrder <= opts.maxTakerFillsPerOrder,
    detail:
      takerOrders <= 0
        ? `not-applicable: no taker orders in last ${opts.takerWindowHours}h`
        : `fills_per_order=${takerFillsPerOrder.toFixed(3)} (${takerFills}/${takerOrders}), max=${opts.maxTakerFillsPerOrder.toFixed(3)}`
  });

  const synthetic = sqlite
    .prepare(
      `SELECT
         COUNT(*) as total_fills,
         COALESCE(SUM(CASE WHEN method = 'synthetic_fill' THEN 1 ELSE 0 END), 0) as synthetic_fills
       FROM shadow_fills
       WHERE ts >= ?`
    )
    .get(sinceTaker) as { total_fills: number; synthetic_fills: number } | undefined;
  const totalFills = synthetic?.total_fills ?? 0;
  const syntheticFills = synthetic?.synthetic_fills ?? 0;
  const syntheticRatio = totalFills > 0 ? syntheticFills / totalFills : 0;
  push(results, {
    name: "Synthetic fill ratio",
    required: true,
    passed: totalFills === 0 || syntheticRatio <= opts.maxSyntheticFillRatio,
    detail:
      totalFills <= 0
        ? `not-applicable: no fills in last ${opts.takerWindowHours}h`
        : `synthetic=${syntheticFills}/${totalFills} (${fmtPct(syntheticRatio)}), max=${fmtPct(opts.maxSyntheticFillRatio)}`
  });

  const makerOrderFill = sqlite
    .prepare(
      `SELECT
         COUNT(DISTINCT o.id) as orders,
         COUNT(f.id) as realFills
       FROM shadow_orders o
       LEFT JOIN shadow_fills f
         ON f.order_id = o.id
        AND (f.method IS NULL OR f.method != 'synthetic_fill')
       WHERE o.kind IN ('MAKER_BID', 'MAKER_ASK')
         AND o.execution_mode = 'SHADOW'
         AND o.ts >= ?`
    )
    .get(sinceTaker) as { orders: number; realFills: number } | undefined;
  const makerOrders = makerOrderFill?.orders ?? 0;
  const makerRealFills = makerOrderFill?.realFills ?? 0;
  const makerFillRate = makerOrders > 0 ? makerRealFills / makerOrders : 0;
  push(results, {
    name: "Realism: maker real fill rate",
    required: opts.enforceRealism,
    passed: makerFillRate >= opts.makerRealFillRateMin,
    detail: `fill_rate=${makerFillRate.toFixed(6)} (${makerRealFills}/${makerOrders}), min=${opts.makerRealFillRateMin.toFixed(6)}`
  });
  push(results, {
    name: "Realism: maker real fills",
    required: opts.enforceRealism,
    passed: makerRealFills >= opts.makerRealFillsMin,
    detail: `real_fills=${makerRealFills}, min=${opts.makerRealFillsMin}`
  });

  const takerFillRows = sqlite
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
    .all(sinceTaker) as Array<{
    walletId: number;
    tokenId: string;
    side: string;
    price: number;
    size: number;
    ts: number;
  }>;
  const takerFillsForLedger: ShadowFillInput[] = [];
  const takerGroupSides = new Map<string, { buy: boolean; sell: boolean }>();
  for (const row of takerFillRows) {
    if (row.side !== "BUY" && row.side !== "SELL") continue;
    takerFillsForLedger.push({
      walletId: row.walletId,
      tokenId: row.tokenId,
      side: row.side,
      price: row.price,
      size: row.size,
      ts: row.ts
    });
    const key = `${row.walletId}:${row.tokenId}`;
    const sideState = takerGroupSides.get(key) ?? { buy: false, sell: false };
    if (row.side === "BUY") sideState.buy = true;
    if (row.side === "SELL") sideState.sell = true;
    takerGroupSides.set(key, sideState);
  }

  const takerLedger = buildShadowPositionLedger(takerFillsForLedger);
  let openedCycles = 0;
  let closedCycles = 0;
  for (const state of takerLedger.values()) {
    openedCycles += state.openedCycles;
    closedCycles += state.closedCycles;
  }
  const takerCloseRatio = openedCycles > 0 ? closedCycles / openedCycles : 0;
  push(results, {
    name: "Realism: taker close ratio",
    required: opts.enforceRealism,
    passed: takerCloseRatio >= opts.takerCloseRatioMin,
    detail: `close_ratio=${takerCloseRatio.toFixed(6)} (closed=${closedCycles}, opened=${openedCycles}), min=${opts.takerCloseRatioMin.toFixed(6)}`
  });

  let activeTakerGroups = 0;
  let oneSidedTakerGroups = 0;
  for (const sideState of takerGroupSides.values()) {
    if (!sideState.buy && !sideState.sell) continue;
    activeTakerGroups += 1;
    if (sideState.buy !== sideState.sell) oneSidedTakerGroups += 1;
  }
  const takerOneSidedRatio = activeTakerGroups > 0 ? oneSidedTakerGroups / activeTakerGroups : 0;
  push(results, {
    name: "Realism: taker one-sided ratio",
    required: opts.enforceRealism,
    passed: takerOneSidedRatio <= opts.takerOneSidedMax,
    detail: `one_sided_ratio=${takerOneSidedRatio.toFixed(6)} (${oneSidedTakerGroups}/${activeTakerGroups}), max=${opts.takerOneSidedMax.toFixed(6)}`
  });

  const makerLiveRow = sqlite
    .prepare("SELECT value FROM settings WHERE key = 'maker_live_execution' LIMIT 1")
    .get() as { value: string | number | null } | undefined;
  const makerLiveValue = makerLiveRow?.value == null ? "0" : String(makerLiveRow.value);
  const nonShadowOrders = (sqlite
    .prepare(
      `SELECT COUNT(*) as c
       FROM shadow_orders
       WHERE UPPER(COALESCE(execution_mode, '')) IN ('FULL', 'LIVE')`
    )
    .get() as { c: number } | undefined)?.c ?? 0;
  const nonShadowFills = (sqlite
    .prepare(
      `SELECT COUNT(*) as c
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE UPPER(COALESCE(o.execution_mode, '')) IN ('FULL', 'LIVE')`
    )
    .get() as { c: number } | undefined)?.c ?? 0;

  if (!opts.allowLiveFlags) {
    push(results, {
      name: "Live execution safety flags",
      required: true,
      passed: makerLiveValue === "0" && nonShadowOrders === 0 && nonShadowFills === 0,
      detail: `maker_live_execution=${makerLiveValue}, non_shadow_orders=${nonShadowOrders}, non_shadow_fills=${nonShadowFills}`
    });
  } else {
    push(results, {
      name: "Live execution safety flags",
      required: false,
      passed: true,
      detail: `allow-live-flags=true (maker_live_execution=${makerLiveValue}, non_shadow_orders=${nonShadowOrders}, non_shadow_fills=${nonShadowFills})`
    });
  }

  const promotionSince = now - opts.promotionDays * 24 * 60 * 60 * 1000;
  const decisionDays = sqlite
    .prepare(
      `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') as day, COUNT(*) as c
       FROM decision_log
       WHERE decision = 'SUBMIT'
         AND ts >= ?
       GROUP BY day`
    )
    .all(promotionSince) as Array<{ day: string; c: number }>;
  const observedDays = new Set(
    decisionDays.filter((row) => row.c > 0 && typeof row.day === "string").map((row) => row.day)
  );
  const expectedDays: string[] = [];
  for (let i = 0; i < opts.promotionDays; i += 1) {
    expectedDays.push(fmtUtcDay(now - i * 24 * 60 * 60 * 1000));
  }
  const missingDays = expectedDays.filter((day) => !observedDays.has(day));
  push(results, {
    name: "Consecutive UTC decision days",
    required: true,
    passed: missingDays.length === 0,
    detail:
      missingDays.length === 0
        ? `covered_days=${opts.promotionDays}`
        : `missing_days=${missingDays.join(", ")}`
  });

  const globalDecisionCount = (
    sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM decision_log
         WHERE decision = 'SUBMIT'
           AND ts >= ?`
      )
      .get(promotionSince) as { c: number }
  ).c;
  const globalFillCount = (
    sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE o.ts >= ?
           AND (f.method IS NULL OR f.method != 'synthetic_fill')`
      )
      .get(promotionSince) as { c: number }
  ).c;
  const globalMarkoutStats = sqlite
    .prepare(
      `SELECT
         COUNT(*) as n,
         AVG(m.markout_bps) as mean,
         AVG(m.markout_bps * m.markout_bps) as meanSq
       FROM shadow_markouts m
       JOIN shadow_fills f ON f.id = m.fill_id
       WHERE m.horizon_ms = ?
         AND m.ts >= ?
         AND (f.method IS NULL OR f.method != 'synthetic_fill')`
    )
    .get(opts.globalHorizonMs, promotionSince) as { n: number; mean: number | null; meanSq: number | null };
  const globalLcb = oneSidedLowerBound(globalMarkoutStats.mean, globalMarkoutStats.meanSq, globalMarkoutStats.n, opts.lowerBoundZ);
  const globalSamplesPass =
    globalDecisionCount >= opts.globalMinDecisions &&
    globalFillCount >= opts.globalMinFills &&
    globalMarkoutStats.n >= opts.globalMinMarkouts;
  push(results, {
    name: "Global promotion sample sizes",
    required: true,
    passed: globalSamplesPass,
    detail: `decisions=${globalDecisionCount}/${opts.globalMinDecisions}, fills=${globalFillCount}/${opts.globalMinFills}, markouts=${globalMarkoutStats.n}/${opts.globalMinMarkouts}`
  });
  push(results, {
    name: "Global one-sided lower bound > 0",
    required: true,
    passed: globalSamplesPass && globalLcb != null && globalLcb > 0,
    detail:
      globalLcb == null
        ? "insufficient markout moments"
        : `horizon_ms=${opts.globalHorizonMs}, lcb_bps=${globalLcb.toFixed(4)}, z=${opts.lowerBoundZ}`
  });

  const realizedFillRows = sqlite
    .prepare(
      `SELECT
         LOWER(COALESCE(NULLIF(o.strategy_lane, ''), CASE
           WHEN o.kind LIKE 'MAKER_%' THEN 'maker'
           WHEN o.kind LIKE 'TAKER_%' THEN 'taker'
           ELSE 'unknown'
         END)) as profile,
         o.wallet_id as walletId,
         o.token_id as tokenId,
         o.side as side,
         f.price as price,
         f.size as size,
         f.ts as ts
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE o.ts >= ?
         AND (f.method IS NULL OR f.method != 'synthetic_fill')
         AND o.kind IN ('MAKER_BID', 'MAKER_ASK', 'INVENTORY_REBALANCE', 'TAKER_BUY', 'TAKER_SELL')
       ORDER BY f.ts ASC`
    )
    .all(promotionSince) as Array<{
    profile: string | null;
    walletId: number;
    tokenId: string;
    side: string;
    price: number;
    size: number;
    ts: number;
  }>;

  const globalRealizedFills: ShadowFillInput[] = [];
  const profileRealizedFills = new Map<string, ShadowFillInput[]>();
  for (const row of realizedFillRows) {
    if (row.side !== "BUY" && row.side !== "SELL") continue;
    if (!Number.isFinite(row.price) || !Number.isFinite(row.size) || !Number.isFinite(row.ts)) continue;
    const fill: ShadowFillInput = {
      walletId: row.walletId,
      tokenId: row.tokenId,
      side: row.side,
      price: row.price,
      size: row.size,
      ts: row.ts
    };
    globalRealizedFills.push(fill);
    const profile = normalizeProfile(row.profile);
    const arr = profileRealizedFills.get(profile) ?? [];
    arr.push(fill);
    profileRealizedFills.set(profile, arr);
  }

  const sumRealizedPnl = (fills: ShadowFillInput[]): number => {
    const ledger = buildShadowPositionLedger(fills);
    let realized = 0;
    for (const state of ledger.values()) realized += state.realizedPnl;
    return realized;
  };

  const globalRealizedPnl = sumRealizedPnl(globalRealizedFills);
  push(results, {
    name: "Global realized PnL (shadow)",
    required: true,
    passed: globalRealizedPnl >= opts.globalMinRealizedPnl,
    detail: `realized_usd=${globalRealizedPnl.toFixed(4)}, min=${opts.globalMinRealizedPnl.toFixed(4)}, fills=${globalRealizedFills.length}`
  });

  const profileRealizedPnlByProfile = new Map<string, number>();
  for (const [profile, fills] of profileRealizedFills.entries()) {
    profileRealizedPnlByProfile.set(profile, sumRealizedPnl(fills));
  }

  const decisionProfiles = sqlite
    .prepare(
      `SELECT
         LOWER(COALESCE(NULLIF(strategy_lane, ''), CASE
           WHEN kind LIKE 'MAKER_%' THEN 'maker'
           WHEN kind LIKE 'TAKER_%' THEN 'taker'
           ELSE 'unknown'
         END)) as profile,
         COUNT(*) as decisionCount
       FROM decision_log
       WHERE decision = 'SUBMIT'
         AND ts >= ?
       GROUP BY 1`
    )
    .all(promotionSince) as Array<{ profile: string; decisionCount: number }>;
  const fillProfiles = sqlite
    .prepare(
      `SELECT
         LOWER(COALESCE(NULLIF(o.strategy_lane, ''), CASE
           WHEN o.kind LIKE 'MAKER_%' THEN 'maker'
           WHEN o.kind LIKE 'TAKER_%' THEN 'taker'
           ELSE 'unknown'
         END)) as profile,
         COUNT(DISTINCT f.id) as fillCount,
         COUNT(m.id) as markoutCount,
         AVG(m.markout_bps) as mean,
         AVG(m.markout_bps * m.markout_bps) as meanSq
       FROM shadow_orders o
       LEFT JOIN shadow_fills f
         ON f.order_id = o.id
        AND (f.method IS NULL OR f.method != 'synthetic_fill')
       LEFT JOIN shadow_markouts m
         ON m.fill_id = f.id
        AND m.horizon_ms = ?
       WHERE o.ts >= ?
       GROUP BY 1`
    )
    .all(opts.globalHorizonMs, promotionSince) as Array<{
    profile: string;
    fillCount: number;
    markoutCount: number;
    mean: number | null;
    meanSq: number | null;
  }>;

  const profiles = new Set<string>();
  for (const row of decisionProfiles) profiles.add(normalizeProfile(row.profile));
  for (const row of fillProfiles) profiles.add(normalizeProfile(row.profile));
  const passingProfiles: string[] = [];
  const blockedProfiles: string[] = [];
  const profilePassByName = new Map<string, boolean>();
  const profileSummaryByName = new Map<string, string>();

  for (const profile of profiles) {
    const dRow = decisionProfiles.find((row) => normalizeProfile(row.profile) === profile);
    const fRow = fillProfiles.find((row) => normalizeProfile(row.profile) === profile);
    const decisionCount = dRow?.decisionCount ?? 0;
    const fillCount = fRow?.fillCount ?? 0;
    const markoutCount = fRow?.markoutCount ?? 0;
    const lcb = oneSidedLowerBound(fRow?.mean ?? null, fRow?.meanSq ?? null, markoutCount, opts.lowerBoundZ);
    const realizedPnl = profileRealizedPnlByProfile.get(profile) ?? 0;
    const pass =
      decisionCount >= opts.profileMinDecisions &&
      fillCount >= opts.profileMinFills &&
      markoutCount >= opts.profileMinMarkouts &&
      realizedPnl >= opts.profileMinRealizedPnl &&
      lcb != null &&
      lcb > 0;
    const summary = `${profile}(d=${decisionCount},f=${fillCount},m=${markoutCount},r=${realizedPnl.toFixed(3)},lcb=${lcb != null ? lcb.toFixed(3) : "na"})`;
    profilePassByName.set(profile, pass);
    profileSummaryByName.set(profile, summary);
    if (pass) passingProfiles.push(summary);
    else blockedProfiles.push(summary);
  }

  const missingRequiredProfiles = opts.requiredProfiles.filter((profile) => !profileSummaryByName.has(profile));
  const failingRequiredProfiles = opts.requiredProfiles.filter(
    (profile) => profileSummaryByName.has(profile) && !profilePassByName.get(profile)
  );
  const requiredProfilesSatisfied =
    opts.requiredProfiles.length > 0
      ? missingRequiredProfiles.length === 0 && failingRequiredProfiles.length === 0
      : passingProfiles.length > 0;

  push(results, {
    name: "Profile-level promotion gate",
    required: true,
    passed: requiredProfilesSatisfied,
    detail:
      opts.requiredProfiles.length > 0
        ? `required=${opts.requiredProfiles.join(",")}; missing_required=${missingRequiredProfiles.join(",") || "none"}; failing_required=${failingRequiredProfiles.join(",") || "none"}; passing_any=${passingProfiles.join(" | ") || "none"}${blockedProfiles.length > 0 ? `; blocked=${blockedProfiles.join(" | ")}` : ""}`
        : passingProfiles.length > 0
          ? `passing=${passingProfiles.join(" | ")}${blockedProfiles.length > 0 ? `; blocked=${blockedProfiles.join(" | ")}` : ""}`
          : `no profile passed; evaluated=${blockedProfiles.join(" | ") || "none"}`
  });

  return results;
}

function printResults(results: GateResult[]): void {
  const line = "═".repeat(96);
  console.log(`\n${line}`);
  console.log("GO-LIVE GATE RESULTS");
  console.log(line);
  for (const result of results) {
    const status = result.passed ? "PASS" : "FAIL";
    const req = result.required ? "REQ" : "OPT";
    console.log(`[${status}] [${req}] ${result.name}`);
    console.log(`       ${result.detail}`);
    if (result.evidence) {
      console.log("       output:");
      const prefixed = result.evidence
        .split(/\r?\n/)
        .map((lineItem) => `         ${lineItem}`)
        .join("\n");
      console.log(prefixed);
    }
  }
}

function main(): void {
  const args = parseCliArgs();
  if (boolArg(args, "help", false) || boolArg(args, "h", false)) {
    printUsage();
    return;
  }

  const repoRoot = resolveRepoRoot();
  const dbRaw = stringArg(args, "db", "data/dev.db");
  const dbPath = path.isAbsolute(dbRaw) ? dbRaw : path.join(repoRoot, dbRaw);

  const verbose = boolArg(args, "verbose", false);
  const skipTests = boolArg(args, "skip-tests", true);
  const skipInvariants = boolArg(args, "skip-invariants", false);
  const testScript = stringArg(args, "test-script", "test");
  const allowLiveFlags = boolArg(args, "allow-live-flags", false);
  const requiredProfiles = parseProfileList(stringArg(args, "required-profiles", "maker,taker"));
  const phaseRaw = stringArg(args, "phase", "frozen").toLowerCase();
  const phase: "burn-in" | "frozen" = phaseRaw === "burn-in" ? "burn-in" : "frozen";
  const enforceRealism = phase === "frozen";
  const freezeManifest = stringArg(args, "freeze-manifest", "configs/freeze-manifest.json");
  const freezeBaseline = stringArg(args, "freeze-baseline", "data/freeze/fingerprint.baseline.json");

  const dbOpts: DbCheckOptions = {
    minTrades15m: numberArg(args, "min-trades-15m", 50),
    maxFeatureStaleSec: numberArg(args, "max-feature-stale-sec", 120),
    maxFeatureStaleRatio: numberArg(args, "max-feature-stale-ratio", 0.25),
    minFreshRows5m: numberArg(args, "min-fresh-rows-5m", 10),
    featureActiveWindowMin: numberArg(args, "feature-active-window-min", 5),
    takerWindowHours: numberArg(args, "taker-window-hours", 24),
    maxTakerFillsPerOrder: numberArg(args, "max-taker-fills-per-order", 1.1),
    maxSyntheticFillRatio: numberArg(args, "max-synthetic-fill-ratio", 0),
    allowLiveFlags,
    requiredProfiles,
    globalMinRealizedPnl: numberArg(args, "global-min-realized-pnl", 0),
    profileMinRealizedPnl: numberArg(args, "profile-min-realized-pnl", 0),
    promotionDays: numberArg(args, "promotion-days", 7),
    globalMinDecisions: numberArg(args, "global-min-decisions", 200),
    globalMinFills: numberArg(args, "global-min-fills", 120),
    globalMinMarkouts: numberArg(args, "global-min-markouts", 120),
    globalHorizonMs: numberArg(args, "global-horizon-ms", 300_000),
    lowerBoundZ: numberArg(args, "lower-bound-z", 1.6448536269514722),
    profileMinDecisions: numberArg(args, "profile-min-decisions", 50),
    profileMinFills: numberArg(args, "profile-min-fills", 30),
    profileMinMarkouts: numberArg(args, "profile-min-markouts", 30),
    enforceRealism,
    makerRealFillRateMin: numberArg(args, "maker-real-fill-rate-min", 0.02),
    makerRealFillsMin: numberArg(args, "maker-real-fills-min", 20),
    takerCloseRatioMin: numberArg(args, "taker-close-ratio-min", 0.15),
    takerOneSidedMax: numberArg(args, "taker-one-sided-max", 0.85)
  };

  const results: GateResult[] = [];
  const sharedEnv = { DB_PATH: dbPath };

  console.log("\n" + "═".repeat(96));
  console.log("GO-LIVE GATE");
  console.log("═".repeat(96));
  console.log(`db=${dbPath}`);
  console.log(`phase=${phase} (realism_enforced=${enforceRealism ? "yes" : "no"})`);
  console.log(`test_script=${testScript}`);
  console.log(
    `thresholds: min_trades_15m=${dbOpts.minTrades15m}, max_feature_stale_ratio=${fmtPct(
      dbOpts.maxFeatureStaleRatio
    )}, min_fresh_rows_5m=${dbOpts.minFreshRows5m}, feature_active_window_min=${dbOpts.featureActiveWindowMin}, max_taker_fills_per_order=${dbOpts.maxTakerFillsPerOrder.toFixed(
      3
    )}, max_synthetic_fill_ratio=${fmtPct(dbOpts.maxSyntheticFillRatio)}, maker_real_fill_rate_min=${dbOpts.makerRealFillRateMin.toFixed(6)}, maker_real_fills_min=${dbOpts.makerRealFillsMin}, taker_close_ratio_min=${dbOpts.takerCloseRatioMin.toFixed(6)}, taker_one_sided_max=${dbOpts.takerOneSidedMax.toFixed(6)}, promotion_days=${dbOpts.promotionDays}, required_profiles=${dbOpts.requiredProfiles.join(",") || "none"}, global_min_realized_pnl=${dbOpts.globalMinRealizedPnl.toFixed(4)}, profile_min_realized_pnl=${dbOpts.profileMinRealizedPnl.toFixed(4)}, global_min_decisions=${dbOpts.globalMinDecisions}, global_min_fills=${dbOpts.globalMinFills}, global_min_markouts=${dbOpts.globalMinMarkouts}, profile_min_decisions=${dbOpts.profileMinDecisions}, profile_min_fills=${dbOpts.profileMinFills}, profile_min_markouts=${dbOpts.profileMinMarkouts}`
  );

  if (!skipInvariants) {
    push(
      results,
      runCommandGate({
        name: "Invariant: no signal schema",
        command: "npx",
        args: ["tsx", "scripts/invariants/no-signal-schema.ts", "--db", dbPath],
        timeoutMs: 2 * 60_000,
        env: sharedEnv,
        verbose
      })
    );
    push(
      results,
      runCommandGate({
        name: "Invariant: decision chain integrity",
        command: "npx",
        args: ["tsx", "scripts/invariants/decision-chain-integrity.ts", "--db", dbPath],
        timeoutMs: 5 * 60_000,
        env: sharedEnv,
        verbose
      })
    );
    push(
      results,
      runCommandGate({
        name: "Invariant: decisionedge contract",
        command: "npx",
        args: ["tsx", "scripts/invariants/decisionedge-contract.ts", "--db", dbPath, "--window-min", "60"],
        timeoutMs: 2 * 60_000,
        env: sharedEnv,
        verbose
      })
    );
    push(
      results,
      runCommandGate({
        name: "Invariant: decision log append-only",
        command: "npx",
        args: [
          "tsx",
          "scripts/invariants/decision-log-append-only.ts",
          "--db",
          dbPath,
          "--allow-empty-rebase"
        ],
        timeoutMs: 2 * 60_000,
        env: sharedEnv,
        verbose
      })
    );
  } else {
    push(results, {
      name: "Invariant scripts",
      required: false,
      passed: true,
      detail: "Skipped via --skip-invariants"
    });
  }

  if (!skipTests) {
    push(
      results,
      runCommandGate({
        name: `Test suite (${testScript})`,
        required: false,
        command: "npm",
        args: ["run", testScript],
        timeoutMs: 15 * 60_000,
        env: sharedEnv,
        verbose
      })
    );
  } else {
    push(results, {
      name: "Test suite",
      required: false,
      passed: true,
      detail: "Skipped (decision-only default)"
    });
  }

  push(
    results,
    runCommandGate({
      name: "Runtime liveness invariant",
      required: enforceRealism,
      command: "npx",
      args: [
        "tsx",
        "scripts/invariants/runtime-liveness.ts",
        "--db",
        dbPath,
        "--feed-max-age-sec",
        String(dbOpts.maxFeatureStaleSec)
      ],
      timeoutMs: 2 * 60_000,
      env: sharedEnv,
      verbose
    })
  );
  push(
    results,
    runCommandGate({
      name: "Freeze fingerprint",
      required: enforceRealism,
      command: "npx",
      args: [
        "tsx",
        "scripts/freeze/fingerprint.ts",
        "--manifest",
        freezeManifest,
        "--baseline",
        freezeBaseline
      ],
      timeoutMs: 2 * 60_000,
      env: sharedEnv,
      verbose
    })
  );

  let sqlite: SqliteDb | null = null;
  try {
    sqlite = openReadOnlyDatabase(dbPath);
    const dbResults = runDbChecks(sqlite, dbOpts);
    for (const r of dbResults) push(results, r);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    push(results, {
      name: "DB checks",
      required: true,
      passed: false,
      detail: `Failed to execute DB checks: ${message}`
    });
  } finally {
    if (sqlite) safeClose(sqlite);
  }

  printResults(results);

  const requiredFailures = results.filter((r) => r.required && !r.passed);
  const optionalFailures = results.filter((r) => !r.required && !r.passed);
  console.log("\n" + "─".repeat(96));
  console.log(
    `Summary: required_failures=${requiredFailures.length}, optional_failures=${optionalFailures.length}, total_checks=${results.length}`
  );

  if (requiredFailures.length > 0) {
    console.log("NO-GO: one or more required gates failed.");
    process.exit(1);
  }

  console.log("GO: all required gates passed.");
}

main();
