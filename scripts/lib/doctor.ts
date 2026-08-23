import path from "node:path";
import type { SqliteDb } from "./db.js";
import {
  MAKER_KINDS,
  TAKER_KINDS,
  configHash,
  createFeatureMidLookup,
  discoverDbPath,
  discoverLedgerPath,
  getMaxTs,
  missingColumns,
  nowMinusHours,
  openReadOnlyDatabase,
  openWritableDatabase,
  parseCliArgs,
  resolveRepoRoot,
  resolveWindowAnchorTs,
  safeClose,
  selectDecisions,
  selectFills,
  selectMarkouts,
  selectOrders,
  selectFillsMissingMarkout,
  shortGitHash,
  tableExists,
  streamTimeContinuity,
  toIsoRunId,
  type DecisionRow,
  type FillRow,
  type MarkoutRow
} from "./db.js";
import {
  bootstrapCycleLevelCi,
  bootstrapFillLevelCi,
  bucketNetEdgeBps,
  bucketSpreadBps,
  computeMarkoutBps,
  computeSpreadBpsFromBidAsk,
  computeSpreadBpsFromSpreadPx,
  mean,
  pearsonCorrelation,
  reconstructCycles
} from "./metrics.js";
import { ensureDir, stableJsonStringify, writeCsvFile, writeJsonFile } from "./io.js";
import { appendLedgerEntry, initLedgerSchema } from "./ledger.js";

export type CheckVerdict = "pass" | "fail" | "inconclusive";

export type FailureRecommendation = {
  symptom: string;
  why: string;
  likelyCauses: string[];
  nextFix: string;
  reproArtifact: string | null;
  validationCommand: string;
};

export type DoctorCheckResult = {
  code: "A" | "B" | "C" | "D";
  checkName: string;
  hypothesis: string;
  verdict: CheckVerdict;
  counts: Record<string, number | string | null>;
  warnings: string[];
  failures: FailureRecommendation[];
  artifacts: string[];
  durationMs: number;
};

export type DoctorRunOptions = {
  dbPath?: string;
  ledgerPath?: string;
  hours?: number;
  horizonMs?: number;
  strict?: boolean;
  outDir?: string;
  runId?: string;
  quick?: boolean;
  skipLedger?: boolean;
};

export type DoctorRunResult = {
  runId: string;
  runTs: number;
  dbPath: string;
  ledgerPath: string | null;
  outDir: string;
  quick: boolean;
  strict: boolean;
  hours: number;
  horizonMs: number;
  anchorTs: number;
  sinceTs: number;
  gitHash: string | null;
  configHash: string | null;
  overallVerdict: CheckVerdict;
  checks: DoctorCheckResult[];
  runArtifacts: string[];
};

type CheckContext = {
  sqlite: SqliteDb;
  dbPath: string;
  outDir: string;
  runId: string;
  runTs: number;
  quick: boolean;
  strict: boolean;
  hours: number;
  horizonMs: number;
  anchorTs: number;
  sinceTs: number;
  validationCommand: string;
};

type CoverageRow = {
  flow: "maker" | "taker" | "other";
  fillsTotal: number;
  fillsWithMarkout: number;
  coveragePct: number;
};

type MarkoutDiffRow = {
  fillId: number;
  tokenId: string;
  kind: string;
  side: string;
  markoutBps: number | null;
  arithmeticBps: number | null;
  arithmeticDiffBps: number | null;
  featureBps: number | null;
  featureDiffBps: number | null;
  featureReason: string | null;
};

type CostDiffRow = {
  orderId: number;
  kind: string;
  spreadBps: number | null;
  spreadFromBookBps: number | null;
  spreadDiffBps: number | null;
  costBps: number | null;
  expectedCostBps: number | null;
  costDiffBps: number | null;
  reason: string;
};

type JoinDupRow = {
  fillId: number;
  rowCount: number;
  tokenId: string;
  kind: string;
  side: string;
  fillTs: number;
};

const ARITHMETIC_MARKOUT_TOLERANCE_BPS = 0.1;
const FEATURE_MARKOUT_TOLERANCE_BPS = 5;
const SPREAD_TOLERANCE_BPS = 1;
const COST_TOLERANCE_BPS = 1;

function relPath(p: string): string {
  const relative = path.relative(process.cwd(), p);
  if (relative.startsWith(".")) return relative;
  return `./${relative}`;
}

function safePct(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return (numerator / denominator) * 100;
}

function median(values: number[]): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1] ?? NaN;
    const hi = sorted[mid] ?? NaN;
    return (lo + hi) / 2;
  }
  return sorted[mid] ?? NaN;
}

function quantile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? NaN;
  const loVal = sorted[lo] ?? NaN;
  const hiVal = sorted[hi] ?? NaN;
  return loVal + (idx - lo) * (hiVal - loVal);
}

function medianAbs(values: number[]): number {
  const cleaned = values.filter((v) => Number.isFinite(v)).map((v) => Math.abs(v));
  return median(cleaned);
}

function flowFromKind(kind: string): "maker" | "taker" | "other" {
  if (MAKER_KINDS.includes(kind as (typeof MAKER_KINDS)[number])) return "maker";
  if (TAKER_KINDS.includes(kind as (typeof TAKER_KINDS)[number])) return "taker";
  return "other";
}

function createArtifactWriter(ctx: CheckContext): {
  writeCsv: (fileName: string, rows: Array<Record<string, unknown>>, headers?: string[]) => string;
  writeJson: (fileName: string, payload: unknown) => string;
} {
  const writeCsv = (
    fileName: string,
    rows: Array<Record<string, unknown>>,
    headers?: string[]
  ): string => {
    const filePath = path.join(ctx.outDir, fileName);
    return relPath(writeCsvFile(filePath, rows, headers));
  };
  const writeJson = (fileName: string, payload: unknown): string => {
    const filePath = path.join(ctx.outDir, fileName);
    return relPath(writeJsonFile(filePath, payload));
  };
  return { writeCsv, writeJson };
}

function makeValidationCommand(ctx: CheckContext): string {
  const strictFlag = ctx.strict ? " --strict" : "";
  return `npx tsx scripts/doctor.ts --db ${ctx.dbPath} --hours ${ctx.hours} --horizonMs ${ctx.horizonMs}${strictFlag}`;
}

function finalizeCheck(
  check: Omit<DoctorCheckResult, "durationMs">,
  startedAt: number
): DoctorCheckResult {
  return {
    ...check,
    durationMs: Date.now() - startedAt
  };
}

function runCoreAccountingChecks(ctx: CheckContext): DoctorCheckResult {
  const startedAt = Date.now();
  const artifact = createArtifactWriter(ctx);
  const failures: FailureRecommendation[] = [];
  const warnings: string[] = [];
  const artifacts: string[] = [];

  const required = {
    shadow_orders: [
      "id",
      "ts",
      "wallet_id",
      "token_id",
      "side",
      "kind",
      "execution_mode",
      "spread_bps",
      "cost_bps"
    ],
    shadow_fills: ["id", "ts", "order_id", "price", "size", "method"],
    shadow_markouts: ["id", "fill_id", "ts", "horizon_ms", "mid_at_fill", "mid_at_horizon", "markout_bps"],
    features: ["id", "ts", "token_id", "mid"],
    decision_log: ["id", "ts", "kind", "decision"]
  };
  const missing = missingColumns(ctx.sqlite, required);
  const missingRows = Object.entries(missing)
    .flatMap(([table, columns]) => columns.map((column) => ({ table, column })))
    .sort((a, b) => (a.table === b.table ? a.column.localeCompare(b.column) : a.table.localeCompare(b.table)));
  if (missingRows.length > 0) {
    const artifactPath = artifact.writeCsv("coverage.csv", missingRows, ["table", "column"]);
    artifacts.push(artifactPath);
    failures.push({
      symptom: `Schema health failed: missing ${missingRows.length} required columns`,
      why: "Doctor checks cannot prove invariants when required schema fields are absent.",
      likelyCauses: [
        "Migrations were not applied on this DB snapshot.",
        "The provided --db points to an older/incorrect SQLite file.",
        "Runtime wrote to a different DB path than the one being checked."
      ],
      nextFix: "scripts/migrate.ts",
      reproArtifact: artifactPath,
      validationCommand: makeValidationCommand(ctx)
    });
  }

  const continuity = [
    streamTimeContinuity(ctx.sqlite, "shadow_orders", "ts", "id"),
    streamTimeContinuity(ctx.sqlite, "shadow_fills", "ts", "id"),
    streamTimeContinuity(ctx.sqlite, "shadow_markouts", "ts", "id"),
    streamTimeContinuity(ctx.sqlite, "features", "ts", "id"),
    streamTimeContinuity(ctx.sqlite, "decision_log", "ts", "id")
  ];
  const majorInversions = continuity.reduce((sum, row) => sum + row.majorInversions, 0);
  if (majorInversions > 0) {
    warnings.push(`Time continuity warning: ${majorInversions} major timestamp inversions across streams`);
    const continuityPath = artifact.writeJson("time_continuity.json", continuity);
    artifacts.push(continuityPath);
  }

  if (missingRows.length > 0) {
    const counts: Record<string, number | string | null> = {
      missing_columns: missingRows.length,
      schema_tables_missing: Object.keys(missing).length,
      fills_matured: 0,
      markouts: 0,
      join_dupes: 0,
      join_missing: 0,
      arithmetic_eval: 0,
      arithmetic_mismatch: 0,
      feature_eval: 0,
      feature_mismatch: 0,
      feature_missing: 0,
      spread_eval: 0,
      cost_eval: 0,
      cost_mismatch: 0
    };
    return finalizeCheck(
      {
        code: "A",
        checkName: "core-accounting-invariants",
        hypothesis:
          "Schema, joins, markouts, and cost decomposition are internally consistent for the selected window.",
        verdict: "fail",
        counts,
        warnings,
        failures,
        artifacts
      },
      startedAt
    );
  }

  const maturedCutoff = ctx.anchorTs - ctx.horizonMs;
  const coverageFills = selectFills(ctx.sqlite, {
    sinceTs: ctx.sinceTs,
    untilTs: maturedCutoff,
    flow: "all",
    executionMode: "SHADOW",
    includeSynthetic: false
  });
  const markouts = selectMarkouts(ctx.sqlite, {
    horizonMs: ctx.horizonMs,
    sinceTs: ctx.sinceTs,
    untilTs: maturedCutoff,
    flow: "all",
    executionMode: "SHADOW",
    includeSynthetic: false
  });

  const totalByFlow = new Map<"maker" | "taker" | "other", number>([
    ["maker", 0],
    ["taker", 0],
    ["other", 0]
  ]);
  for (const fill of coverageFills) {
    const flow = flowFromKind(fill.kind);
    totalByFlow.set(flow, (totalByFlow.get(flow) ?? 0) + 1);
  }

  const distinctMarkoutFillIds = new Set<number>();
  const markoutByFlow = new Map<"maker" | "taker" | "other", number>([
    ["maker", 0],
    ["taker", 0],
    ["other", 0]
  ]);
  for (const row of markouts) {
    if (distinctMarkoutFillIds.has(row.fillId)) continue;
    distinctMarkoutFillIds.add(row.fillId);
    const flow = flowFromKind(row.kind);
    markoutByFlow.set(flow, (markoutByFlow.get(flow) ?? 0) + 1);
  }

  const coverageRows: CoverageRow[] = (["maker", "taker", "other"] as const).map((flow) => {
    const fillsTotal = totalByFlow.get(flow) ?? 0;
    const fillsWithMarkout = markoutByFlow.get(flow) ?? 0;
    return {
      flow,
      fillsTotal,
      fillsWithMarkout,
      coveragePct: safePct(fillsWithMarkout, fillsTotal)
    };
  });
  const fillsMissingMarkout = selectFillsMissingMarkout(ctx.sqlite, {
    sinceTs: ctx.sinceTs,
    untilTs: maturedCutoff,
    horizonMs: ctx.horizonMs,
    flow: "all",
    executionMode: "SHADOW",
    includeSynthetic: false
  });

  let coverageArtifactPath: string | null = null;
  const coverageArtifactRows = [
    ...coverageRows.map((row) => ({
      row_type: "summary",
      flow: row.flow,
      fills_total: row.fillsTotal,
      fills_with_markout: row.fillsWithMarkout,
      coverage_pct: Number(row.coveragePct.toFixed(4)),
      fill_id: null,
      fill_ts: null,
      order_id: null,
      wallet_id: null,
      token_id: null,
      side: null,
      kind: null,
      method: null
    })),
    ...fillsMissingMarkout.slice(0, 5_000).map((row) => ({
      row_type: "missing_markout_fill",
      flow: flowFromKind(row.kind),
      fills_total: null,
      fills_with_markout: null,
      coverage_pct: null,
      fill_id: row.fillId,
      fill_ts: row.fillTs,
      order_id: row.orderId,
      wallet_id: row.walletId,
      token_id: row.tokenId,
      side: row.side,
      kind: row.kind,
      method: row.method
    }))
  ];
  const lowCoverage = coverageRows.filter(
    (row) => row.fillsTotal > 0 && row.coveragePct < (ctx.strict ? 99 : 95)
  );
  if (lowCoverage.length > 0) {
    coverageArtifactPath = artifact.writeCsv("coverage.csv", coverageArtifactRows);
    artifacts.push(coverageArtifactPath);
    failures.push({
      symptom: `Markout coverage below threshold for ${lowCoverage.map((r) => r.flow).join(", ")}`,
      why: "Coverage gaps mean downstream EV/PnL diagnostics are sampling-biased and non-reproducible.",
      likelyCauses: [
        "Markout backfill lagged relative to fill ingestion.",
        "Feature mids at fill_ts or fill_ts+horizon are missing for some tokens.",
        "Horizon mismatch between markout writer and doctor run."
      ],
      nextFix: "apps/worker/src/shadow/ShadowExecutionLoop.ts",
      reproArtifact: coverageArtifactPath,
      validationCommand: makeValidationCommand(ctx)
    });
  } else if (coverageFills.length === 0) {
    warnings.push("No matured fills in window for coverage check.");
    if (ctx.strict) {
      coverageArtifactPath = artifact.writeCsv("coverage.csv", coverageArtifactRows);
      artifacts.push(coverageArtifactPath);
      failures.push({
        symptom: "No matured fills available for coverage invariant in strict mode",
        why: "Without matured fills, markout correctness cannot be validated end-to-end.",
        likelyCauses: [
          "Selected --hours window does not include active trading.",
          "Horizon is too long relative to available data range.",
          "DB snapshot is stale."
        ],
        nextFix: "scripts/doctor.ts",
        reproArtifact: coverageArtifactPath,
        validationCommand: makeValidationCommand(ctx)
      });
    }
  }

  const joinIntegrityRows = ctx.sqlite
    .prepare(
      `SELECT
         f.id as fillId,
         COUNT(m.id) as rowCount,
         o.token_id as tokenId,
         o.kind as kind,
         o.side as side,
         f.ts as fillTs
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       LEFT JOIN shadow_markouts m ON m.fill_id = f.id AND m.horizon_ms = ?
       WHERE o.execution_mode = 'SHADOW'
         AND (f.method IS NULL OR f.method != 'synthetic_fill')
         AND f.ts >= ?
         AND f.ts <= ?
       GROUP BY f.id
       HAVING COUNT(m.id) != 1
       ORDER BY rowCount DESC, fillId ASC`
    )
    .all(ctx.horizonMs, ctx.sinceTs, maturedCutoff) as JoinDupRow[];
  const joinDuplicateCount = joinIntegrityRows.filter((row) => row.rowCount > 1).length;
  const joinMissingCount = joinIntegrityRows.filter((row) => row.rowCount === 0).length;

  let joinDupArtifact: string | null = null;
  if (joinIntegrityRows.length > 0) {
    joinDupArtifact = artifact.writeCsv(
      "join_dupes.csv",
      joinIntegrityRows.map((row) => ({
        fill_id: row.fillId,
        markout_rows: row.rowCount,
        issue_type: row.rowCount > 1 ? "duplicate_markout_rows" : "missing_markout_row",
        token_id: row.tokenId,
        kind: row.kind,
        side: row.side,
        fill_ts: row.fillTs
      }))
    );
    artifacts.push(joinDupArtifact);
    failures.push({
      symptom:
        `Join integrity failed: duplicates=${joinDuplicateCount} missing=${joinMissingCount} ` +
        `(must be exactly 1 markout row per matured fill)`,
      why: "Markout joins should be one row per fill per horizon; missing or duplicate rows bias EV/PnL.",
      likelyCauses: [
        "Duplicate markout inserts occurred without uniqueness protection.",
        "Backfill lag left matured fills without markouts at this horizon.",
        "Horizon filter mismatch during join generated accidental one-to-many rows."
      ],
      nextFix: "apps/worker/src/shadow/ShadowExecutionLoop.ts",
      reproArtifact: joinDupArtifact,
      validationCommand: makeValidationCommand(ctx)
    });
  }

  const midLookup = createFeatureMidLookup(ctx.sqlite);
  const diffRows: MarkoutDiffRow[] = [];
  let arithmeticEvaluated = 0;
  let arithmeticMismatches = 0;
  let featureEvaluated = 0;
  let featureMismatches = 0;
  let featureMissing = 0;

  for (const row of markouts) {
    const record: MarkoutDiffRow = {
      fillId: row.fillId,
      tokenId: row.tokenId,
      kind: row.kind,
      side: row.side,
      markoutBps: row.markoutBps,
      arithmeticBps: null,
      arithmeticDiffBps: null,
      featureBps: null,
      featureDiffBps: null,
      featureReason: null
    };

    if (
      row.markoutBps != null &&
      row.midAtFill != null &&
      row.midAtHorizon != null &&
      Number.isFinite(row.midAtFill) &&
      Number.isFinite(row.midAtHorizon) &&
      row.midAtFill > 0
    ) {
      const arithmetic = computeMarkoutBps(row.side, row.midAtFill, row.midAtHorizon);
      const diff = Math.abs(arithmetic - row.markoutBps);
      arithmeticEvaluated += 1;
      record.arithmeticBps = arithmetic;
      record.arithmeticDiffBps = diff;
      if (diff > ARITHMETIC_MARKOUT_TOLERANCE_BPS) {
        arithmeticMismatches += 1;
      }
    }

    const featureFillMid = midLookup.midAtOrBefore(row.tokenId, row.fillTs);
    const featureHorizonMid = midLookup.midAtOrAfter(row.tokenId, row.fillTs + ctx.horizonMs);
    if (
      row.markoutBps == null ||
      featureFillMid == null ||
      featureHorizonMid == null ||
      !Number.isFinite(featureFillMid) ||
      !Number.isFinite(featureHorizonMid) ||
      featureFillMid <= 0
    ) {
      featureMissing += 1;
      if (featureFillMid == null) {
        record.featureReason = "missing_feature_at_fill";
      } else if (featureHorizonMid == null) {
        record.featureReason = "missing_feature_at_horizon";
      } else {
        record.featureReason = "missing_markout_or_invalid_feature";
      }
    } else {
      const featureMarkout = computeMarkoutBps(row.side, featureFillMid, featureHorizonMid);
      const featureDiff = Math.abs(featureMarkout - row.markoutBps);
      featureEvaluated += 1;
      record.featureBps = featureMarkout;
      record.featureDiffBps = featureDiff;
      if (featureDiff > FEATURE_MARKOUT_TOLERANCE_BPS) {
        featureMismatches += 1;
      }
    }

    if (
      (record.arithmeticDiffBps != null && record.arithmeticDiffBps > ARITHMETIC_MARKOUT_TOLERANCE_BPS) ||
      (record.featureDiffBps != null && record.featureDiffBps > FEATURE_MARKOUT_TOLERANCE_BPS)
    ) {
      diffRows.push(record);
    }
  }

  let markoutDiffArtifact: string | null = null;
  if (diffRows.length > 0 || (ctx.strict && featureEvaluated === 0 && markouts.length > 0)) {
    markoutDiffArtifact = artifact.writeCsv(
      "markout_diff.csv",
      diffRows
        .sort((a, b) => a.fillId - b.fillId)
        .map((row) => ({
          fill_id: row.fillId,
          token_id: row.tokenId,
          kind: row.kind,
          side: row.side,
          markout_bps: row.markoutBps,
          arithmetic_bps: row.arithmeticBps,
          arithmetic_diff_bps: row.arithmeticDiffBps,
          feature_bps: row.featureBps,
          feature_diff_bps: row.featureDiffBps,
          feature_reason: row.featureReason
        }))
    );
    artifacts.push(markoutDiffArtifact);
  }
  if (diffRows.length > 0) {
    failures.push({
      symptom: `Markout reconciliation failed: ${diffRows.length} mismatched fills`,
      why: "Stored markouts diverge from canonical formulas and/or features-based recomputation.",
      likelyCauses: [
        "Side sign convention mismatch in markout computation.",
        "mid_at_fill or mid_at_horizon persisted with wrong lookup direction.",
        "Markout rows were generated before feature data was complete."
      ],
      nextFix: "apps/worker/src/shadow/ShadowExecutionLoop.ts",
      reproArtifact: markoutDiffArtifact,
      validationCommand: makeValidationCommand(ctx)
    });
  }

  const orders = selectOrders(ctx.sqlite, {
    sinceTs: ctx.sinceTs,
    untilTs: ctx.anchorTs,
    flow: "all",
    executionMode: "SHADOW"
  });
  const costDiffRows: CostDiffRow[] = [];
  let spreadEvaluated = 0;
  let costEvaluated = 0;
  for (const order of orders) {
    if (!Number.isFinite(order.spreadBps ?? NaN)) continue;
    const spreadBps = order.spreadBps as number;

    let spreadFromBook: number | null = null;
    if (
      Number.isFinite(order.bidPx ?? NaN) &&
      Number.isFinite(order.askPx ?? NaN) &&
      Number.isFinite(order.midPx ?? NaN) &&
      (order.midPx ?? 0) > 0
    ) {
      spreadFromBook = computeSpreadBpsFromBidAsk(order.bidPx as number, order.askPx as number, order.midPx as number);
    } else if (
      Number.isFinite(order.spreadPx ?? NaN) &&
      Number.isFinite(order.midPx ?? NaN) &&
      (order.midPx ?? 0) > 0
    ) {
      spreadFromBook = computeSpreadBpsFromSpreadPx(order.spreadPx as number, order.midPx as number);
    }

    if (spreadFromBook != null && Number.isFinite(spreadFromBook)) {
      spreadEvaluated += 1;
      const spreadDiff = Math.abs(spreadFromBook - spreadBps);
      if (spreadDiff > SPREAD_TOLERANCE_BPS) {
        costDiffRows.push({
          orderId: order.orderId,
          kind: order.kind,
          spreadBps,
          spreadFromBookBps: spreadFromBook,
          spreadDiffBps: spreadDiff,
          costBps: order.costBps,
          expectedCostBps: null,
          costDiffBps: null,
          reason: "spread_formula_mismatch"
        });
      }
    }

    if (!Number.isFinite(order.costBps ?? NaN)) continue;
    costEvaluated += 1;
    const fees = Number.isFinite(order.feesBps ?? NaN) ? (order.feesBps as number) : 0;
    const slip = Number.isFinite(order.expectedSlippageBps ?? NaN)
      ? (order.expectedSlippageBps as number)
      : 0;
    const adverse = Number.isFinite(order.expectedAdverseBps ?? NaN)
      ? (order.expectedAdverseBps as number)
      : 0;
    const queue = Number.isFinite(order.expectedQueueBps ?? NaN)
      ? (order.expectedQueueBps as number)
      : 0;

    const baseExpected = spreadBps + fees + slip;
    const extendedExpected = baseExpected + adverse + queue;
    const cost = order.costBps as number;
    const bestExpected =
      Math.abs(cost - baseExpected) <= Math.abs(cost - extendedExpected) ? baseExpected : extendedExpected;
    const diff = Math.abs(cost - bestExpected);
    if (diff > COST_TOLERANCE_BPS) {
      costDiffRows.push({
        orderId: order.orderId,
        kind: order.kind,
        spreadBps,
        spreadFromBookBps: spreadFromBook,
        spreadDiffBps: spreadFromBook == null ? null : Math.abs(spreadFromBook - spreadBps),
        costBps: cost,
        expectedCostBps: bestExpected,
        costDiffBps: diff,
        reason: "cost_decomposition_mismatch"
      });
    }
  }

  let costArtifactPath: string | null = null;
  if (costDiffRows.length > 0) {
    costArtifactPath = artifact.writeCsv(
      "cost_diff.csv",
      costDiffRows
        .sort((a, b) => a.orderId - b.orderId)
        .map((row) => ({
          order_id: row.orderId,
          kind: row.kind,
          spread_bps: row.spreadBps,
          spread_from_book_bps: row.spreadFromBookBps,
          spread_diff_bps: row.spreadDiffBps,
          cost_bps: row.costBps,
          expected_cost_bps: row.expectedCostBps,
          cost_diff_bps: row.costDiffBps,
          reason: row.reason
        }))
    );
    artifacts.push(costArtifactPath);
    failures.push({
      symptom: `Cost decomposition sanity failed: ${costDiffRows.length} rows`,
      why: "spread_bps/cost_bps do not match canonical formulas from stored book snapshots.",
      likelyCauses: [
        "Taker cost model changed without updating persisted cost components.",
        "spread_bps was computed from a different denominator than mid_px.",
        "Expected adverse/queue terms were omitted from cost rollup."
      ],
      nextFix: "apps/worker/src/taker/TakerLoop.ts",
      reproArtifact: costArtifactPath,
      validationCommand: makeValidationCommand(ctx)
    });
  } else {
    if (spreadEvaluated === 0) warnings.push("No rows with bid/ask+mid available for spread formula validation.");
    if (costEvaluated === 0) warnings.push("No rows with cost_bps available for cost decomposition validation.");
  }

  const verdict: CheckVerdict =
    failures.length > 0
      ? "fail"
      : coverageFills.length === 0 && !ctx.strict
        ? "inconclusive"
        : "pass";

  const counts: Record<string, number | string | null> = {
    fills_matured: coverageFills.length,
    markouts: markouts.length,
    coverage_missing_rows: fillsMissingMarkout.length,
    coverage_maker_pct: Number((coverageRows.find((row) => row.flow === "maker")?.coveragePct ?? 0).toFixed(3)),
    coverage_taker_pct: Number((coverageRows.find((row) => row.flow === "taker")?.coveragePct ?? 0).toFixed(3)),
    join_dupes: joinDuplicateCount,
    join_missing: joinMissingCount,
    join_not_one: joinIntegrityRows.length,
    arithmetic_eval: arithmeticEvaluated,
    arithmetic_mismatch: arithmeticMismatches,
    feature_eval: featureEvaluated,
    feature_mismatch: featureMismatches,
    feature_missing: featureMissing,
    spread_eval: spreadEvaluated,
    cost_eval: costEvaluated,
    cost_mismatch: costDiffRows.length
  };

  return finalizeCheck(
    {
      code: "A",
      checkName: "core-accounting-invariants",
      hypothesis:
        "Schema, joins, markouts, and cost decomposition are internally consistent for the selected window.",
      verdict,
      counts,
      warnings,
      failures,
      artifacts
    },
    startedAt
  );
}

function runMakerChecks(ctx: CheckContext): DoctorCheckResult {
  const startedAt = Date.now();
  const artifact = createArtifactWriter(ctx);
  const failures: FailureRecommendation[] = [];
  const warnings: string[] = [];
  const artifacts: string[] = [];

  const makerOrders = selectOrders(ctx.sqlite, {
    sinceTs: ctx.sinceTs,
    untilTs: ctx.anchorTs,
    flow: "maker",
    executionMode: "SHADOW"
  });
  const makerFills = selectFills(ctx.sqlite, {
    sinceTs: ctx.sinceTs,
    untilTs: ctx.anchorTs,
    flow: "maker",
    executionMode: "SHADOW",
    includeSynthetic: false
  });
  const makerDecisions = selectDecisions(ctx.sqlite, {
    sinceTs: ctx.sinceTs,
    untilTs: ctx.anchorTs,
    flow: "maker"
  });
  const cycles = reconstructCycles(
    makerFills.map((fill) => ({
      fillId: fill.fillId,
      ts: fill.fillTs,
      walletId: fill.walletId,
      tokenId: fill.tokenId,
      side: fill.side,
      price: fill.price,
      size: fill.size,
      netEdgeBps: fill.netEdgeBps,
      spreadBps: fill.spreadBps
    }))
  );

  const makerOrdersArtifact = artifact.writeCsv(
    "maker_orders_sample.csv",
    makerOrders.slice(0, 250).map((row) => ({
      order_id: row.orderId,
      ts: row.orderTs,
      wallet_id: row.walletId,
      token_id: row.tokenId,
      side: row.side,
      kind: row.kind,
      size: row.size,
      spread_bps: row.spreadBps,
      decision: row.decision,
      decision_reason: row.decisionReason
    }))
  );
  artifacts.push(makerOrdersArtifact);

  const makerFillsArtifact = artifact.writeCsv(
    "maker_fills_sample.csv",
    makerFills.slice(0, 250).map((row) => ({
      fill_id: row.fillId,
      ts: row.fillTs,
      wallet_id: row.walletId,
      token_id: row.tokenId,
      side: row.side,
      kind: row.kind,
      price: row.price,
      size: row.size,
      method: row.method
    }))
  );
  artifacts.push(makerFillsArtifact);

  const makerCyclesArtifact = artifact.writeCsv(
    "maker_cycles_sample.csv",
    cycles.cycles.slice(0, 250).map((row) => ({
      cycle_id: row.cycleId,
      wallet_id: row.walletId,
      token_id: row.tokenId,
      direction: row.direction,
      open_ts: row.openTs,
      close_ts: row.closeTs,
      hold_ms: row.holdMs,
      realized_pnl: row.realizedPnl,
      realized_pnl_bps: row.realizedPnlBps
    }))
  );
  artifacts.push(makerCyclesArtifact);

  const fillsPerOrder = new Map<number, number>();
  for (const fill of makerFills) {
    fillsPerOrder.set(fill.orderId, (fillsPerOrder.get(fill.orderId) ?? 0) + 1);
  }
  const makerOrdersWithFills = makerOrders.filter((order) => (fillsPerOrder.get(order.orderId) ?? 0) > 0).length;
  const makerFillRatePct = safePct(makerOrdersWithFills, makerOrders.length);
  let summaryMakerFillRatePct: number | null = null;

  const inventoryDiffRows: Array<Record<string, unknown>> = [];
  const positionByWalletToken = new Map<string, number>();
  const makerFillsOrdered = [...makerFills].sort((a, b) => {
    if ((a.walletId ?? -1) !== (b.walletId ?? -1)) return (a.walletId ?? -1) - (b.walletId ?? -1);
    if (a.tokenId !== b.tokenId) return a.tokenId.localeCompare(b.tokenId);
    if (a.fillTs !== b.fillTs) return a.fillTs - b.fillTs;
    return a.fillId - b.fillId;
  });
  for (const fill of makerFillsOrdered) {
    const sideSign = fill.side === "BUY" ? 1 : fill.side === "SELL" ? -1 : 0;
    const size = fill.size ?? NaN;
    if (sideSign === 0 || !Number.isFinite(size) || size <= 0) continue;
    const key = `${fill.walletId ?? -1}:${fill.tokenId}`;
    const expectedBefore = positionByWalletToken.get(key) ?? 0;
    const expectedAfter = expectedBefore + sideSign * size;
    const storedBefore = fill.inventoryIBefore;
    const storedAfter = fill.inventoryIAfter;
    const beforeDiff =
      storedBefore != null && Number.isFinite(storedBefore) ? Math.abs(storedBefore - expectedBefore) : null;
    const afterDiff =
      storedAfter != null && Number.isFinite(storedAfter) ? Math.abs(storedAfter - expectedAfter) : null;

    if ((beforeDiff != null && beforeDiff > 1e-6) || (afterDiff != null && afterDiff > 1e-6)) {
      inventoryDiffRows.push({
        fill_id: fill.fillId,
        ts: fill.fillTs,
        wallet_id: fill.walletId,
        token_id: fill.tokenId,
        side: fill.side,
        size: fill.size,
        expected_inventory_before: expectedBefore,
        stored_inventory_before: storedBefore,
        before_diff: beforeDiff,
        expected_inventory_after: expectedAfter,
        stored_inventory_after: storedAfter,
        after_diff: afterDiff
      });
    }

    positionByWalletToken.set(key, expectedAfter);
  }

  const noMakerData = makerOrders.length === 0 && makerFills.length === 0;
  if (noMakerData) {
    warnings.push("No maker orders/fills in selected window.");
    if (ctx.strict) {
      failures.push({
        symptom: "Maker pipeline has zero activity in strict mode",
        why: "Maker sanity cannot be validated without quote/order/fill evidence.",
        likelyCauses: [
          "Maker loop is disabled at wallet or worker configuration level.",
          "No markets passed maker eligibility gates.",
          "DB window does not include periods with maker activity."
        ],
        nextFix: "apps/worker/src/maker/MakerLoop.ts",
        reproArtifact: makerOrdersArtifact,
        validationCommand: makeValidationCommand(ctx)
      });
    }
  } else {
    if (makerDecisions.length > 0 && makerOrders.length === 0) {
      failures.push({
        symptom: "Maker decisions exist but no maker orders were persisted",
        why: "Quote-to-order stage is dropping decisions before order write.",
        likelyCauses: [
          "Decision path exits before insertShadowOrder execution.",
          "Maker order insert failed due schema/constraint mismatch.",
          "Execution mode filter excluded maker writes."
        ],
        nextFix: "apps/worker/src/maker/MakerLoop.ts",
        reproArtifact: makerOrdersArtifact,
        validationCommand: makeValidationCommand(ctx)
      });
    }

    if (makerOrders.length > 0 && makerFills.length === 0 && !ctx.quick) {
      failures.push({
        symptom: "Maker orders have zero fills",
        why: "Order-to-fill stage did not realize any fills; cycle and PnL invariants are untestable.",
        likelyCauses: [
          "Synthetic/real fill simulation disabled or misconfigured.",
          "Maker quotes are consistently outside fillable bounds.",
          "Fill ingestion from clob_events is stale."
        ],
        nextFix: "apps/worker/src/shadow/ShadowExecutionLoop.ts",
        reproArtifact: makerFillsArtifact,
        validationCommand: makeValidationCommand(ctx)
      });
    }

    if (cycles.anomalies.length > 0) {
      const anomalyPath = artifact.writeCsv(
        "maker_cycle_anomalies.csv",
        cycles.anomalies.slice(0, 500).map((row) => ({
          group_key: row.groupKey,
          fill_id: row.fillId,
          ts: row.ts,
          code: row.code,
          detail: row.detail
        }))
      );
      artifacts.push(anomalyPath);
      failures.push({
        symptom: `Cycle reconstruction found ${cycles.anomalies.length} invalid maker fill rows`,
        why: "Invalid fill rows break inventory and realized PnL invariants.",
        likelyCauses: [
          "Fill records contain non-positive size or invalid side values.",
          "Out-of-order fill ingestion introduced time inversions per wallet/token stream.",
          "Maker fill write path bypassed validation."
        ],
        nextFix: "apps/worker/src/shadow/ShadowExecutionLoop.ts",
        reproArtifact: anomalyPath,
        validationCommand: makeValidationCommand(ctx)
      });
    }

    if (inventoryDiffRows.length > 0) {
      const inventoryArtifact = artifact.writeCsv("maker_inventory_diff.csv", inventoryDiffRows.slice(0, 2_000));
      artifacts.push(inventoryArtifact);
      failures.push({
        symptom: `Inventory accounting mismatch on ${inventoryDiffRows.length} maker fills`,
        why: "Reconstructed positions from fills do not match stored inventory fields.",
        likelyCauses: [
          "inventory_i_before/inventory_i_after were captured from stale in-memory state.",
          "Fill replay ordering differs from the order used to persist inventory fields.",
          "Maker inventory updates skipped a branch before writing shadow_orders."
        ],
        nextFix: "apps/worker/src/maker/MakerLoop.ts",
        reproArtifact: inventoryArtifact,
        validationCommand: makeValidationCommand(ctx)
      });
    }

    const summaryRow = ctx.sqlite
      .prepare(
        `SELECT maker_orders as makerOrders, maker_fills as makerFills
         FROM shadow_summary_latest
         WHERE id = 1`
      )
      .get() as { makerOrders: number | null; makerFills: number | null } | undefined;
    if (summaryRow && Number.isFinite(summaryRow.makerOrders ?? NaN) && Number.isFinite(summaryRow.makerFills ?? NaN)) {
      const dbOrders = Number(summaryRow.makerOrders ?? 0);
      const dbFills = Number(summaryRow.makerFills ?? 0);
      const dbFillRatePct = safePct(dbFills, dbOrders);
      summaryMakerFillRatePct = dbFillRatePct;
      const fillRateDiffPct = Math.abs(dbFillRatePct - makerFillRatePct);
      if (Math.abs(dbOrders - makerOrders.length) > Math.max(5, Math.ceil(makerOrders.length * 0.05))) {
        failures.push({
          symptom: `Maker order count mismatch: reconstructed=${makerOrders.length}, summary=${dbOrders}`,
          why: "Summary cache diverges from canonical shadow_orders base table.",
          likelyCauses: [
            "Summary refresh loop lagged or failed to upsert.",
            "Summary window differs from doctor window assumptions.",
            "Maker order kinds in summary and doctor filters are inconsistent."
          ],
          nextFix: "apps/worker/src/shadow/ShadowExecutionLoop.ts",
          reproArtifact: makerOrdersArtifact,
          validationCommand: makeValidationCommand(ctx)
        });
      }
      if (Math.abs(dbFills - makerFills.length) > Math.max(5, Math.ceil(makerFills.length * 0.05))) {
        failures.push({
          symptom: `Maker fill count mismatch: reconstructed=${makerFills.length}, summary=${dbFills}`,
          why: "Summary fill accounting diverges from canonical fills table.",
          likelyCauses: [
            "Summary excludes a subset of maker fill methods while doctor includes them.",
            "Shadow summary table was not refreshed after recent fills.",
            "Maker kind classification drifted between query paths."
          ],
          nextFix: "apps/worker/src/shadow/ShadowExecutionLoop.ts",
          reproArtifact: makerFillsArtifact,
          validationCommand: makeValidationCommand(ctx)
        });
      }
      if (makerOrders.length > 0 && dbOrders > 0 && fillRateDiffPct > 2) {
        const fillRateArtifact = artifact.writeCsv("maker_fill_rate.csv", [
          {
            reconstructed_orders: makerOrders.length,
            reconstructed_fills: makerFills.length,
            reconstructed_fill_rate_pct: Number(makerFillRatePct.toFixed(4)),
            summary_orders: dbOrders,
            summary_fills: dbFills,
            summary_fill_rate_pct: Number(dbFillRatePct.toFixed(4)),
            abs_fill_rate_diff_pct: Number(fillRateDiffPct.toFixed(4))
          }
        ]);
        artifacts.push(fillRateArtifact);
        failures.push({
          symptom:
            `Maker fill-rate mismatch: reconstructed=${makerFillRatePct.toFixed(2)}% vs summary=${dbFillRatePct.toFixed(2)}%`,
          why: "Order→fill attribution in summary diverges from canonical order/fill joins.",
          likelyCauses: [
            "Summary refresh loop uses a different maker-kind filter.",
            "Summary rollup window is inconsistent with doctor window.",
            "Some fills are counted without matching maker orders."
          ],
          nextFix: "apps/worker/src/shadow/ShadowExecutionLoop.ts",
          reproArtifact: fillRateArtifact,
          validationCommand: makeValidationCommand(ctx)
        });
      }
    } else {
      warnings.push("shadow_summary_latest unavailable for maker fill-rate reconciliation.");
    }

    if (tableExists(ctx.sqlite, "shadow_maker_metrics_latest")) {
      const metricsRows = ctx.sqlite.prepare(
        `SELECT
           wallet_id as walletId,
           updated_ts as updatedTs,
           window_hours as windowHours,
           total_realized as totalRealized,
           fill_count as fillCount
         FROM shadow_maker_metrics_latest
         WHERE wallet_id != 0
         ORDER BY wallet_id ASC`
      ).all() as Array<{
        walletId: number;
        updatedTs: number;
        windowHours: number;
        totalRealized: number;
        fillCount: number;
      }>;

      const realizedByWallet = new Map<number, number>();
      for (const cycle of cycles.cycles) {
        if (cycle.walletId == null) continue;
        realizedByWallet.set(cycle.walletId, (realizedByWallet.get(cycle.walletId) ?? 0) + cycle.realizedPnl);
      }
      const fillsByWallet = new Map<number, number>();
      for (const fill of makerFills) {
        if (fill.walletId == null) continue;
        fillsByWallet.set(fill.walletId, (fillsByWallet.get(fill.walletId) ?? 0) + 1);
      }

      const metricDiffRows = metricsRows
        .map((row) => {
          const reconstructedRealized = realizedByWallet.get(row.walletId) ?? 0;
          const reconstructedFillCount = fillsByWallet.get(row.walletId) ?? 0;
          const realizedDiff = reconstructedRealized - row.totalRealized;
          const fillCountDiff = reconstructedFillCount - row.fillCount;
          return {
            wallet_id: row.walletId,
            updated_ts: row.updatedTs,
            window_hours: row.windowHours,
            stored_total_realized: row.totalRealized,
            reconstructed_total_realized: Number(reconstructedRealized.toFixed(8)),
            realized_diff: Number(realizedDiff.toFixed(8)),
            stored_fill_count: row.fillCount,
            reconstructed_fill_count: reconstructedFillCount,
            fill_count_diff: fillCountDiff
          };
        })
        .filter(
          (row) =>
            Math.abs(row.realized_diff) > Math.max(5, Math.abs(row.reconstructed_total_realized) * 0.25) ||
            Math.abs(row.fill_count_diff) > Math.max(2, Math.ceil(Math.abs(row.reconstructed_fill_count) * 0.2))
        );

      if (metricDiffRows.length > 0) {
        const metricsArtifact = artifact.writeCsv("maker_metrics_diff.csv", metricDiffRows);
        artifacts.push(metricsArtifact);
        failures.push({
          symptom: `Maker PnL attribution mismatch for ${metricDiffRows.length} wallet metric rows`,
          why: "Cycle-level realized PnL does not reconcile with stored maker metrics.",
          likelyCauses: [
            "Maker metrics rollup uses a different window than doctor reconstruction.",
            "Realized PnL updates were skipped on some close events.",
            "Wallet-level aggregation excludes partial close or flip semantics."
          ],
          nextFix: "apps/worker/src/shadow/ShadowExecutionLoop.ts",
          reproArtifact: metricsArtifact,
          validationCommand: makeValidationCommand(ctx)
        });
      }
    } else {
      warnings.push("shadow_maker_metrics_latest unavailable for maker PnL reconciliation.");
    }
  }

  const makerMarkouts = selectMarkouts(ctx.sqlite, {
    horizonMs: ctx.horizonMs,
    sinceTs: ctx.sinceTs,
    untilTs: ctx.anchorTs - ctx.horizonMs,
    flow: "maker",
    executionMode: "SHADOW",
    includeSynthetic: false
  });

  const cyclePnlBps = cycles.cycles
    .map((cycle) => cycle.realizedPnlBps)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const makerHoldMsValues = cycles.cycles
    .map((cycle) => cycle.holdMs)
    .filter((value): value is number => Number.isFinite(value));
  const makerHoldMedianMs = median(makerHoldMsValues);
  const makerHoldP95Ms = quantile(makerHoldMsValues, 0.95);
  const markoutValues = makerMarkouts
    .map((row) => row.markoutBps)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const spreadCapture = makerFills
    .map((fill) => fill.spreadBps)
    .filter((value): value is number => value != null && Number.isFinite(value))
    .map((spread) => spread / 2);

  const fillCi = bootstrapFillLevelCi(markoutValues.map((value) => ({ value })), { iterations: 500, seed: 2026 });
  const cycleCi = bootstrapCycleLevelCi(
    cycles.cycles,
    (cycle) => cycle.realizedPnlBps,
    { iterations: 500, seed: 2027 }
  );

  const verdict: CheckVerdict =
    failures.length > 0
      ? "fail"
      : noMakerData
        ? "inconclusive"
        : "pass";

  const counts: Record<string, number | string | null> = {
    maker_orders: makerOrders.length,
    maker_fills: makerFills.length,
    maker_orders_with_fills: makerOrdersWithFills,
    maker_fill_rate_pct: Number(makerFillRatePct.toFixed(4)),
    maker_summary_fill_rate_pct:
      summaryMakerFillRatePct != null ? Number(summaryMakerFillRatePct.toFixed(4)) : null,
    maker_decisions: makerDecisions.length,
    maker_cycles_closed: cycles.cycles.length,
    maker_cycles_open: cycles.openStates.length,
    maker_cycle_anomalies: cycles.anomalies.length,
    maker_inventory_diff_rows: inventoryDiffRows.length,
    maker_hold_median_ms: Number(makerHoldMedianMs.toFixed(2)),
    maker_hold_p95_ms: Number(makerHoldP95Ms.toFixed(2)),
    maker_markouts: makerMarkouts.length,
    maker_gross_ev_bps: Number(mean(markoutValues).toFixed(4)),
    maker_spread_capture_bps: Number(mean(spreadCapture).toFixed(4)),
    maker_realized_proxy_bps: Number(mean(cyclePnlBps).toFixed(4)),
    fill_ci_lo: Number(fillCi.ciLo.toFixed(4)),
    fill_ci_hi: Number(fillCi.ciHi.toFixed(4)),
    cycle_ci_lo: Number(cycleCi.ciLo.toFixed(4)),
    cycle_ci_hi: Number(cycleCi.ciHi.toFixed(4))
  };

  return finalizeCheck(
    {
      code: "B",
      checkName: "maker-pipeline-invariants",
      hypothesis:
        "Maker decisions, fills, inventory, and cycle-level EV/PnL attribution are internally consistent.",
      verdict,
      counts,
      warnings,
      failures,
      artifacts
    },
    startedAt
  );
}

function runTakerChecks(ctx: CheckContext): DoctorCheckResult {
  const startedAt = Date.now();
  const artifact = createArtifactWriter(ctx);
  const failures: FailureRecommendation[] = [];
  const warnings: string[] = [];
  const artifacts: string[] = [];

  const takerOrders = selectOrders(ctx.sqlite, {
    sinceTs: ctx.sinceTs,
    untilTs: ctx.anchorTs,
    flow: "taker",
    executionMode: "SHADOW"
  });
  const takerFills = selectFills(ctx.sqlite, {
    sinceTs: ctx.sinceTs,
    untilTs: ctx.anchorTs,
    flow: "taker",
    executionMode: "SHADOW",
    includeSynthetic: false
  });
  const takerDecisions = selectDecisions(ctx.sqlite, {
    sinceTs: ctx.sinceTs,
    untilTs: ctx.anchorTs,
    flow: "taker"
  });

  const cycles = reconstructCycles(
    takerFills.map((fill) => ({
      fillId: fill.fillId,
      ts: fill.fillTs,
      walletId: fill.walletId,
      tokenId: fill.tokenId,
      side: fill.side,
      price: fill.price,
      size: fill.size,
      netEdgeBps: fill.netEdgeBps,
      spreadBps: fill.spreadBps
    }))
  );
  const closedCycles = cycles.cycles;
  const holdMsValues = closedCycles.map((cycle) => cycle.holdMs).filter((ms) => Number.isFinite(ms));

  const takerDecisionsArtifact = artifact.writeCsv(
    "taker_decisions_sample.csv",
    takerDecisions.slice(0, 500).map((row) => ({
      id: row.id,
      ts: row.ts,
      token_id: row.tokenId,
      wallet_id: row.walletId,
      kind: row.kind,
      decision: row.decision,
      decision_reason: row.decisionReason,
      pred_edge_bps: row.predEdgeBps,
      net_edge_bps: row.netEdgeBps
    }))
  );
  artifacts.push(takerDecisionsArtifact);

  const takerCyclesArtifact = artifact.writeCsv(
    "taker_cycles_sample.csv",
    closedCycles.slice(0, 500).map((row) => ({
      cycle_id: row.cycleId,
      wallet_id: row.walletId,
      token_id: row.tokenId,
      direction: row.direction,
      open_ts: row.openTs,
      close_ts: row.closeTs,
      hold_ms: row.holdMs,
      realized_pnl: row.realizedPnl,
      realized_pnl_bps: row.realizedPnlBps,
      entry_net_edge_bps: row.entryNetEdgeBps
    }))
  );
  artifacts.push(takerCyclesArtifact);

  const skipRows = takerDecisions.filter((row) => row.decision === "SKIP");
  const missingReasonCount = skipRows.filter((row) => !row.decisionReason || row.decisionReason.trim() === "").length;
  const reasonCounts = new Map<string, number>();
  for (const row of skipRows) {
    const reason = row.decisionReason ?? "missing_reason";
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const sortedReasonCounts = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => (b.count === a.count ? a.reason.localeCompare(b.reason) : b.count - a.count));
  const reasonCategoryCounts = {
    net_edge: 0,
    inventory: 0,
    spread: 0,
    other: 0
  };
  for (const row of skipRows) {
    const reason = (row.decisionReason ?? "").toLowerCase();
    if (reason.includes("net_edge")) {
      reasonCategoryCounts.net_edge += 1;
    } else if (reason.includes("inventory")) {
      reasonCategoryCounts.inventory += 1;
    } else if (reason.includes("spread")) {
      reasonCategoryCounts.spread += 1;
    } else {
      reasonCategoryCounts.other += 1;
    }
  }

  if (takerDecisions.length === 0) {
    warnings.push("No taker decision_log rows in window.");
    if (ctx.strict) {
      failures.push({
        symptom: "Decision gating check has zero decision_log rows in strict mode",
        why: "Taker decision coverage cannot be audited without decision evidence.",
        likelyCauses: [
          "Taker loop did not run in this window.",
          "decision_log writes are disabled or failing.",
          "Window excludes active decision periods."
        ],
        nextFix: "apps/worker/src/taker/TakerLoop.ts",
        reproArtifact: takerDecisionsArtifact,
        validationCommand: makeValidationCommand(ctx)
      });
    }
  }

  if (missingReasonCount > 0) {
    failures.push({
      symptom: `Decision gating reason distribution has ${missingReasonCount} missing reason rows`,
      why: "Gate decisions must encode explicit reasons for reproducible diagnostics.",
      likelyCauses: [
        "A branch in taker gating inserted SKIP without decision_reason.",
        "Decision row schema mapping dropped reason field.",
        "Legacy rows were inserted before reason enrichment."
      ],
      nextFix: "apps/worker/src/taker/TakerLoop.ts",
      reproArtifact: takerDecisionsArtifact,
      validationCommand: makeValidationCommand(ctx)
    });
  }
  if (
    skipRows.length > 0 &&
    reasonCategoryCounts.net_edge + reasonCategoryCounts.inventory + reasonCategoryCounts.spread === 0
  ) {
    failures.push({
      symptom: "Decision gating reasons are present but none match canonical gate categories",
      why: "Skip reasons should map to net-edge, inventory, or spread gate classes for reproducible diagnostics.",
      likelyCauses: [
        "Decision reason strings drifted from expected canonical values.",
        "A refactor replaced machine-readable reasons with free-form text.",
        "Legacy rows were written before reason taxonomy was standardized."
      ],
      nextFix: "apps/worker/src/taker/TakerLoop.ts",
      reproArtifact: takerDecisionsArtifact,
      validationCommand: makeValidationCommand(ctx)
    });
  }

  if (takerFills.length > 0 && closedCycles.length === 0) {
    failures.push({
      symptom: "Entry/exit reconstruction found fills but no closed taker cycles",
      why: "Positions are opening but not closing, so realized PnL cannot be verified.",
      likelyCauses: [
        "Exit logic is not firing and positions are not closing.",
        "Cycle reconstruction input is missing a subset of fills.",
        "Position sign/size conventions between order and fill streams diverged."
      ],
      nextFix: "apps/worker/src/taker/TakerLoop.ts",
      reproArtifact: takerCyclesArtifact,
      validationCommand: makeValidationCommand(ctx)
    });
  }

  const medianExpectedHold = ctx.horizonMs;
  const medianObservedHold = median(holdMsValues);
  const holdP95Ms = quantile(holdMsValues, 0.95);
  if (
    Number.isFinite(medianExpectedHold) &&
    Number.isFinite(medianObservedHold) &&
    (medianObservedHold as number) > (medianExpectedHold as number) * (ctx.quick ? 12 : 8)
  ) {
    failures.push({
      symptom: `Hold-time mismatch: median observed ${(medianObservedHold as number).toFixed(0)}ms vs expected ${(medianExpectedHold as number).toFixed(0)}ms`,
      why: "Taker close policy is not aligned with configured horizon expectations.",
      likelyCauses: [
        "Fallback/exit policy waits too long before closing positions.",
        "Configured expected hold horizon differs from execution-time close horizon.",
        "Stale opportunity filtering prevents timely exits."
      ],
      nextFix: "apps/worker/src/taker/TakerLoop.ts",
      reproArtifact: takerCyclesArtifact,
      validationCommand: makeValidationCommand(ctx)
    });
  }

  const spreadRows = takerOrders.filter((row) => Number.isFinite(row.spreadBps ?? NaN));
  const spreadByTokenHour = new Map<string, { tokenId: string; hourBucket: string; count: number; spreadSum: number }>();
  for (const row of spreadRows) {
    const hourBucket = new Date(row.orderTs).toISOString().slice(0, 13);
    const key = `${row.tokenId}:${hourBucket}`;
    const bucket = spreadByTokenHour.get(key) ?? {
      tokenId: row.tokenId,
      hourBucket,
      count: 0,
      spreadSum: 0
    };
    bucket.count += 1;
    bucket.spreadSum += row.spreadBps as number;
    spreadByTokenHour.set(key, bucket);
  }
  const spreadByTokenHourRows = Array.from(spreadByTokenHour.values())
    .map((row) => ({
      token_id: row.tokenId,
      hour_bucket: row.hourBucket,
      orders: row.count,
      avg_spread_bps: Number((row.spreadSum / Math.max(1, row.count)).toFixed(6))
    }))
    .sort((a, b) => {
      if (a.token_id !== b.token_id) return a.token_id.localeCompare(b.token_id);
      return a.hour_bucket.localeCompare(b.hour_bucket);
    });
  const spreadByTokenHourArtifact = artifact.writeCsv(
    "taker_spread_by_token_hour.csv",
    spreadByTokenHourRows.slice(0, 5_000)
  );
  artifacts.push(spreadByTokenHourArtifact);
  const avgSpread = mean(
    spreadRows.map((row) => row.spreadBps as number).filter((value) => Number.isFinite(value))
  );
  const negativeSpreadCount = spreadRows.filter((row) => (row.spreadBps ?? 0) <= 0).length;
  const crossingViolations = takerOrders.filter((row) => {
    if (!Number.isFinite(row.price ?? NaN)) return false;
    if (row.side === "BUY" && Number.isFinite(row.askPx ?? NaN)) {
      return (row.price as number) + 1e-9 < (row.askPx as number);
    }
    if (row.side === "SELL" && Number.isFinite(row.bidPx ?? NaN)) {
      return (row.price as number) - 1e-9 > (row.bidPx as number);
    }
    return false;
  }).length;
  const crossingViolationRate = safePct(crossingViolations, takerOrders.length);

  if (spreadRows.length === 0) {
    warnings.push("No taker rows with spread_bps found for cost realism check.");
    if (ctx.strict) {
      failures.push({
        symptom: "Taker cost realism lacks spread_bps evidence in strict mode",
        why: "Crossing-cost sanity cannot be proven without spread instrumentation.",
        likelyCauses: [
          "spread_bps was not persisted for taker orders.",
          "Only partial order rows exist and are missing edge fields.",
          "Window excludes decisionable taker submits."
        ],
        nextFix: "apps/worker/src/taker/TakerLoop.ts",
        reproArtifact: takerCyclesArtifact,
        validationCommand: makeValidationCommand(ctx)
      });
    }
  } else {
    if (!Number.isFinite(avgSpread) || avgSpread <= 0 || negativeSpreadCount > 0) {
      failures.push({
        symptom: `Taker spread realism failed: avg_spread=${avgSpread.toFixed(4)} negative_rows=${negativeSpreadCount}`,
        why: "Crossing should pay spread; non-positive spread indicates broken market snapshot wiring.",
        likelyCauses: [
          "best_bid/best_ask fields were stale or inverted when spread_bps was computed.",
          "Spread conversion used wrong denominator.",
          "Order rows were inserted before mid/spread snapshots were available."
        ],
        nextFix: "apps/worker/src/taker/TakerLoop.ts",
        reproArtifact: takerCyclesArtifact,
        validationCommand: makeValidationCommand(ctx)
      });
    }
    if (!ctx.quick && crossingViolationRate > 5) {
      failures.push({
        symptom: `Crossing-price sanity failed: ${crossingViolations}/${takerOrders.length} orders price better than top-of-book`,
        why: "Taker orders should not systematically execute better than crossing prices in shadow realism mode.",
        likelyCauses: [
          "Order price assignment used mid instead of best ask/bid for taker entries.",
          "Book snapshot columns are stale when order rows are persisted.",
          "Price/source fields were overwritten by downstream handling."
        ],
        nextFix: "apps/worker/src/taker/TakerLoop.ts",
        reproArtifact: takerCyclesArtifact,
        validationCommand: makeValidationCommand(ctx)
      });
    }
  }

  const calibrationMarkouts = selectMarkouts(ctx.sqlite, {
    horizonMs: ctx.horizonMs,
    sinceTs: ctx.sinceTs,
    untilTs: ctx.anchorTs - ctx.horizonMs,
    flow: "taker",
    executionMode: "SHADOW",
    includeSynthetic: false
  }).filter((row) => row.kind === "TAKER_BUY" || row.kind === "TAKER_SELL");

  const calibrationRows = calibrationMarkouts.map((row) => ({
    fillId: row.fillId,
    tokenId: row.tokenId,
    kind: row.kind,
    side: row.side,
    predEdgeBps: row.predEdgeBps,
    netEdgeBps: row.netEdgeBps,
    spreadBps: row.spreadBps,
    costBps: row.costBps,
    markoutBps: row.markoutBps
  }));

  const calibrationArtifact = artifact.writeCsv(
    "taker_calibration_sample.csv",
    calibrationRows.slice(0, 500).map((row) => ({
      fill_id: row.fillId,
      token_id: row.tokenId,
      kind: row.kind,
      side: row.side,
      pred_edge_bps: row.predEdgeBps,
      net_edge_bps: row.netEdgeBps,
      spread_bps: row.spreadBps,
      cost_bps: row.costBps,
      markout_bps: row.markoutBps,
      spread_bucket: bucketSpreadBps(row.spreadBps),
      net_edge_bucket: bucketNetEdgeBps(row.netEdgeBps)
    }))
  );
  artifacts.push(calibrationArtifact);

  const rowsWithEdges = calibrationRows.filter(
    (row) =>
      row.predEdgeBps != null &&
      Number.isFinite(row.predEdgeBps) &&
      row.netEdgeBps != null &&
      Number.isFinite(row.netEdgeBps) &&
      row.markoutBps != null &&
      Number.isFinite(row.markoutBps)
  );
  const edgeCoveragePct = safePct(rowsWithEdges.length, calibrationRows.length);
  const predValues = rowsWithEdges.map((row) => row.predEdgeBps as number);
  const markoutValues = rowsWithEdges.map((row) => row.markoutBps as number);
  const corr = pearsonCorrelation(predValues, markoutValues);
  const scaleRatio = medianAbs(predValues) / Math.max(1e-9, medianAbs(markoutValues));

  if (calibrationRows.length === 0) {
    warnings.push("No taker calibration markout rows at selected horizon.");
    if (ctx.strict) {
      failures.push({
        symptom: "Pred→net→realized wiring has zero calibration rows in strict mode",
        why: "Cannot verify edge-to-realized linkage without markout-labeled taker fills.",
        likelyCauses: [
          "No TAKER_BUY/TAKER_SELL fills reached the chosen horizon.",
          "Markout backfill is incomplete for taker entries.",
          "Window does not include recent taker fills."
        ],
        nextFix: "apps/worker/src/shadow/ShadowExecutionLoop.ts",
        reproArtifact: calibrationArtifact,
        validationCommand: makeValidationCommand(ctx)
      });
    }
  } else if (edgeCoveragePct < (ctx.strict ? 95 : 80)) {
    failures.push({
      symptom: `Pred/net edge coverage too low for calibration rows: ${edgeCoveragePct.toFixed(2)}%`,
      why: "Fills without pred_edge/net_edge cannot support calibration and EV attribution.",
      likelyCauses: [
        "Edge trace columns were not populated when taker orders were inserted.",
        "Calibration set unintentionally includes rows without edge context.",
        "A schema migration dropped edge fields for a subset of rows."
      ],
      nextFix: "apps/worker/src/taker/TakerLoop.ts",
      reproArtifact: calibrationArtifact,
      validationCommand: makeValidationCommand(ctx)
    });
  } else if (!ctx.quick && rowsWithEdges.length >= 20 && Number.isFinite(corr) && Number.isFinite(scaleRatio)) {
    if (Math.abs(corr) < 0.02 || scaleRatio > 50 || scaleRatio < 0.02) {
      warnings.push(
        `Calibration diagnostic: corr=${corr.toFixed(4)} scale_ratio=${scaleRatio.toFixed(4)} (possible model scale mismatch)`
      );
      if (ctx.strict) {
        failures.push({
          symptom: `Pred→realized diagnostics out of bounds: corr=${corr.toFixed(4)}, scale_ratio=${scaleRatio.toFixed(4)}`,
          why: "Predicted edge scale does not align with realized markout scale.",
          likelyCauses: [
            "delta_hat to bps conversion is mis-scaled.",
            "Edge uses mid-based denominator while realized uses crossed prices.",
            "Calibration horizon differs from decision horizon."
          ],
          nextFix: "apps/worker/src/taker/TakerLoop.ts",
          reproArtifact: calibrationArtifact,
          validationCommand: makeValidationCommand(ctx)
        });
      }
    }
  }

  const takerCycleCi = bootstrapCycleLevelCi(
    closedCycles,
    (cycle) => cycle.realizedPnlBps,
    { iterations: 500, seed: 2028 }
  );
  const takerFillCi = bootstrapFillLevelCi(
    calibrationRows.map((row) => ({ value: row.markoutBps })),
    { iterations: 500, seed: 2029 }
  );

  const verdict: CheckVerdict =
    failures.length > 0
      ? "fail"
      : takerOrders.length === 0 && !ctx.strict
        ? "inconclusive"
        : "pass";

  const counts: Record<string, number | string | null> = {
    taker_orders: takerOrders.length,
    taker_fills: takerFills.length,
    taker_decisions: takerDecisions.length,
    taker_skip_rows: skipRows.length,
    taker_reason_missing: missingReasonCount,
    taker_reason_net_edge: reasonCategoryCounts.net_edge,
    taker_reason_inventory: reasonCategoryCounts.inventory,
    taker_reason_spread: reasonCategoryCounts.spread,
    taker_reason_other: reasonCategoryCounts.other,
    taker_cycles_closed: closedCycles.length,
    taker_cycles_open: cycles.openStates.length,
    taker_hold_median_ms: Number(medianObservedHold.toFixed(2)),
    taker_hold_p95_ms: Number(holdP95Ms.toFixed(2)),
    taker_horizon_median_ms: Number(medianExpectedHold.toFixed(2)),
    taker_avg_spread_bps: Number(avgSpread.toFixed(4)),
    taker_spread_token_hour_rows: spreadByTokenHourRows.length,
    taker_crossing_violation_pct: Number(crossingViolationRate.toFixed(4)),
    taker_calibration_rows: calibrationRows.length,
    taker_calibration_edge_rows: rowsWithEdges.length,
    taker_calibration_edge_coverage_pct: Number(edgeCoveragePct.toFixed(4)),
    taker_pred_realized_corr: Number(corr.toFixed(6)),
    taker_pred_realized_scale_ratio: Number(scaleRatio.toFixed(6)),
    taker_fill_ci_lo: Number(takerFillCi.ciLo.toFixed(4)),
    taker_fill_ci_hi: Number(takerFillCi.ciHi.toFixed(4)),
    taker_cycle_ci_lo: Number(takerCycleCi.ciLo.toFixed(4)),
    taker_cycle_ci_hi: Number(takerCycleCi.ciHi.toFixed(4))
  };

  if (sortedReasonCounts.length > 0) {
    counts.top_reason = sortedReasonCounts[0]?.reason ?? null;
    counts.top_reason_count = sortedReasonCounts[0]?.count ?? null;
  }

  return finalizeCheck(
    {
      code: "C",
      checkName: "taker-pipeline-invariants",
      hypothesis:
        "Signals, decision gating, fills, holds/closes, and realized PnL diagnostics are internally consistent.",
      verdict,
      counts,
      warnings,
      failures,
      artifacts
    },
    startedAt
  );
}

function runSyntheticChecks(ctx: CheckContext): DoctorCheckResult {
  const startedAt = Date.now();
  const artifact = createArtifactWriter(ctx);
  const failures: FailureRecommendation[] = [];
  const warnings: string[] = [];
  const artifacts: string[] = [];

  const fills = selectFills(ctx.sqlite, {
    sinceTs: ctx.sinceTs,
    untilTs: ctx.anchorTs,
    flow: "all",
    executionMode: "SHADOW",
    includeSynthetic: true
  });
  const synthetic = fills.filter((row) => row.method === "synthetic_fill");
  const real = fills.filter((row) => row.method !== "synthetic_fill");

  const perFlow = new Map<string, { total: number; synthetic: number }>();
  for (const row of fills) {
    const flow = flowFromKind(row.kind);
    const bucket = perFlow.get(flow) ?? { total: 0, synthetic: 0 };
    bucket.total += 1;
    if (row.method === "synthetic_fill") bucket.synthetic += 1;
    perFlow.set(flow, bucket);
  }

  const perHour = new Map<string, { total: number; synthetic: number }>();
  for (const row of fills) {
    const hourBucket = new Date(row.fillTs).toISOString().slice(0, 13);
    const bucket = perHour.get(hourBucket) ?? { total: 0, synthetic: 0 };
    bucket.total += 1;
    if (row.method === "synthetic_fill") bucket.synthetic += 1;
    perHour.set(hourBucket, bucket);
  }

  const ratioRows = Array.from(perFlow.entries())
    .map(([flow, stats]) => ({
      flow,
      total_fills: stats.total,
      synthetic_fills: stats.synthetic,
      synthetic_ratio_pct: Number(safePct(stats.synthetic, stats.total).toFixed(4))
    }))
    .sort((a, b) => a.flow.localeCompare(b.flow));

  const hourRows = Array.from(perHour.entries())
    .map(([hourBucket, stats]) => ({
      hour_bucket: hourBucket,
      total_fills: stats.total,
      synthetic_fills: stats.synthetic,
      synthetic_ratio_pct: Number(safePct(stats.synthetic, stats.total).toFixed(4))
    }))
    .sort((a, b) => a.hour_bucket.localeCompare(b.hour_bucket));

  const ratioArtifact = artifact.writeCsv("synthetic_ratio.csv", ratioRows);
  artifacts.push(ratioArtifact);
  const hourArtifact = artifact.writeCsv("synthetic_ratio_by_hour.csv", hourRows);
  artifacts.push(hourArtifact);

  const triggerRows = synthetic
    .map((row) => ({
      fill_id: row.fillId,
      ts: row.fillTs,
      wallet_id: row.walletId,
      token_id: row.tokenId,
      kind: row.kind,
      method: row.method,
      note: row.note
    }))
    .slice(0, 500);
  const triggerArtifact = artifact.writeCsv("synthetic_triggers_sample.csv", triggerRows);
  artifacts.push(triggerArtifact);

  const markouts = selectMarkouts(ctx.sqlite, {
    horizonMs: ctx.horizonMs,
    sinceTs: ctx.sinceTs,
    untilTs: ctx.anchorTs - ctx.horizonMs,
    flow: "all",
    executionMode: "SHADOW",
    includeSynthetic: true
  });
  const syntheticFillIds = new Set(synthetic.map((row) => row.fillId));
  const syntheticMarkouts = markouts.filter((row) => syntheticFillIds.has(row.fillId));
  const realMarkouts = markouts.filter((row) => !syntheticFillIds.has(row.fillId));

  const syntheticAvg = mean(
    syntheticMarkouts
      .map((row) => row.markoutBps)
      .filter((value): value is number => value != null && Number.isFinite(value))
  );
  const realAvg = mean(
    realMarkouts
      .map((row) => row.markoutBps)
      .filter((value): value is number => value != null && Number.isFinite(value))
  );
  const markoutDiff = Math.abs(syntheticAvg - realAvg);

  const biasArtifact = artifact.writeCsv("synthetic_bias.csv", [
    {
      synthetic_fills: synthetic.length,
      real_fills: real.length,
      synthetic_markouts: syntheticMarkouts.length,
      real_markouts: realMarkouts.length,
      synthetic_avg_markout_bps: Number(syntheticAvg.toFixed(6)),
      real_avg_markout_bps: Number(realAvg.toFixed(6)),
      abs_markout_diff_bps: Number(markoutDiff.toFixed(6))
    }
  ]);
  artifacts.push(biasArtifact);

  const dominatingFlows = ratioRows.filter(
    (row) => row.total_fills >= 20 && row.synthetic_ratio_pct > (ctx.strict ? 20 : 50)
  );
  if (dominatingFlows.length > 0) {
    failures.push({
      symptom: `Synthetic fill ratio dominates flow(s): ${dominatingFlows.map((row) => row.flow).join(", ")}`,
      why: "Synthetic fills dominating execution can bias markout statistics and hide live fill behavior.",
      likelyCauses: [
        "forceSyntheticFills/synthetic interval settings are too aggressive.",
        "Real fill matching logic is not capturing trade events.",
        "Maker-out fallback path is over-triggering synthetic paths."
      ],
      nextFix: "apps/worker/src/shadow/ShadowExecutionLoop.ts",
      reproArtifact: ratioArtifact,
      validationCommand: makeValidationCommand(ctx)
    });
  }

  if (
    syntheticMarkouts.length >= 30 &&
    realMarkouts.length >= 30 &&
    Number.isFinite(markoutDiff) &&
    markoutDiff > (ctx.strict ? 10 : 25)
  ) {
    failures.push({
      symptom: `Synthetic markout bias detected: |synthetic_avg - real_avg|=${markoutDiff.toFixed(2)} bps`,
      why: "Synthetic fill markouts differ materially from real fill markouts, biasing EV attribution.",
      likelyCauses: [
        "Synthetic fill timing/price model is not calibrated to real execution.",
        "Synthetic fills are concentrated in adverse regimes.",
        "Synthetic and real fills are mixed in analytics without weighting safeguards."
      ],
      nextFix: "apps/worker/src/shadow/ShadowExecutionLoop.ts",
      reproArtifact: biasArtifact,
      validationCommand: makeValidationCommand(ctx)
    });
  }

  if (synthetic.length === 0) {
    warnings.push("No synthetic fills found in selected window.");
  }

  const verdict: CheckVerdict = failures.length > 0 ? "fail" : "pass";
  const counts: Record<string, number | string | null> = {
    total_fills: fills.length,
    synthetic_fills: synthetic.length,
    synthetic_ratio_pct: Number(safePct(synthetic.length, fills.length).toFixed(4)),
    synthetic_markouts: syntheticMarkouts.length,
    real_markouts: realMarkouts.length,
    synthetic_avg_markout_bps: Number(syntheticAvg.toFixed(6)),
    real_avg_markout_bps: Number(realAvg.toFixed(6)),
    abs_markout_diff_bps: Number(markoutDiff.toFixed(6))
  };

  return finalizeCheck(
    {
      code: "D",
      checkName: "shadow-synthetic-fill-sanity",
      hypothesis:
        "Synthetic fills are bounded, explainable, and not materially biasing markout diagnostics.",
      verdict,
      counts,
      warnings,
      failures,
      artifacts
    },
    startedAt
  );
}

function computeOverallVerdict(checks: DoctorCheckResult[]): CheckVerdict {
  if (checks.some((check) => check.verdict === "fail")) return "fail";
  if (checks.every((check) => check.verdict === "inconclusive")) return "inconclusive";
  if (checks.some((check) => check.verdict === "inconclusive")) return "inconclusive";
  return "pass";
}

function runCheckSafely(
  ctx: CheckContext,
  checkMeta: {
    code: "A" | "B" | "C" | "D";
    checkName: string;
    hypothesis: string;
    nextFix: string;
  },
  runner: () => DoctorCheckResult
): DoctorCheckResult {
  const startedAt = Date.now();
  try {
    return runner();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : null;
    const artifactPath = relPath(
      writeJsonFile(path.join(ctx.outDir, `check_${checkMeta.code.toLowerCase()}_error.json`), {
        runId: ctx.runId,
        runTs: ctx.runTs,
        checkCode: checkMeta.code,
        checkName: checkMeta.checkName,
        message,
        stack
      })
    );
    return finalizeCheck(
      {
        code: checkMeta.code,
        checkName: checkMeta.checkName,
        hypothesis: checkMeta.hypothesis,
        verdict: "fail",
        counts: {
          error: 1
        },
        warnings: [],
        failures: [
          {
            symptom: `${checkMeta.code} ${checkMeta.checkName} crashed`,
            why: "The check threw an exception before invariants could be fully evaluated.",
            likelyCauses: [
              "Schema drift introduced an unexpected column/table shape.",
              "A query returned data outside the assumptions in this check.",
              "An unchecked null/NaN path caused a runtime error."
            ],
            nextFix: checkMeta.nextFix,
            reproArtifact: artifactPath,
            validationCommand: makeValidationCommand(ctx)
          }
        ],
        artifacts: [artifactPath]
      },
      startedAt
    );
  }
}

function checkToLedgerVerdict(verdict: CheckVerdict): "pass" | "fail" | "inconclusive" {
  if (verdict === "pass") return "pass";
  if (verdict === "fail") return "fail";
  return "inconclusive";
}

export function runDoctor(options: DoctorRunOptions = {}): DoctorRunResult {
  const dbPath = discoverDbPath(options.dbPath);
  const ledgerPath = discoverLedgerPath(options.ledgerPath);
  const outBase = options.outDir
    ? path.isAbsolute(options.outDir)
      ? options.outDir
      : path.resolve(process.cwd(), options.outDir)
    : path.resolve(resolveRepoRoot(), "reports", "doctor");
  const quick = options.quick ?? false;
  const strict = options.strict ?? false;
  const hours = Math.max(1, Math.floor(options.hours ?? 24));
  const horizonMs = Math.max(1000, Math.floor(options.horizonMs ?? 600_000));
  const runTs = Date.now();
  const git = shortGitHash();
  const cfgHash = configHash();
  const runId = options.runId ?? toIsoRunId(runTs, git);
  const runOutDir = ensureDir(path.join(outBase, runId));

  const sqlite = openReadOnlyDatabase(dbPath);
  const ledger = options.skipLedger ? null : openWritableDatabase(ledgerPath);
  if (ledger) initLedgerSchema(ledger);

  const anchorTs = resolveWindowAnchorTs(sqlite, [
    { table: "shadow_orders", column: "ts" },
    { table: "shadow_fills", column: "ts" },
    { table: "shadow_markouts", column: "ts" },
    { table: "features", column: "ts" }
  ]);
  const sinceTs = nowMinusHours(anchorTs, hours);

  const validationCommand =
    `npx tsx scripts/doctor.ts --db ${dbPath} --hours ${hours} --horizonMs ${horizonMs}` +
    (strict ? " --strict" : "");

  const ctx: CheckContext = {
    sqlite,
    dbPath,
    outDir: runOutDir,
    runId,
    runTs,
    quick,
    strict,
    hours,
    horizonMs,
    anchorTs,
    sinceTs,
    validationCommand
  };

  const checks: DoctorCheckResult[] = [];
  checks.push(
    runCheckSafely(
      ctx,
      {
        code: "A",
        checkName: "core-accounting-invariants",
        hypothesis:
          "Schema, joins, markouts, and cost decomposition are internally consistent for the selected window.",
        nextFix: "scripts/doctor.ts"
      },
      () => runCoreAccountingChecks(ctx)
    )
  );
  if (!quick) {
    checks.push(
      runCheckSafely(
        ctx,
        {
          code: "B",
          checkName: "maker-pipeline-invariants",
          hypothesis:
            "Maker decisions, fills, inventory, and cycle-level EV/PnL attribution are internally consistent.",
          nextFix: "apps/worker/src/maker/MakerLoop.ts"
        },
        () => runMakerChecks(ctx)
      )
    );
  } else {
    // Quick mode keeps to highest-value checks only.
    checks.push(
      finalizeCheck(
        {
          code: "B",
          checkName: "maker-pipeline-invariants",
          hypothesis:
            "Quick mode skips deep maker diagnostics; use full doctor for complete maker sanity.",
          verdict: "inconclusive",
          counts: { skipped: 1 },
          warnings: ["Skipped in --quick mode."],
          failures: [],
          artifacts: []
        },
        Date.now()
      )
    );
  }
  checks.push(
    runCheckSafely(
      ctx,
      {
        code: "C",
        checkName: "taker-pipeline-invariants",
        hypothesis:
          "Signals, decision gating, fills, holds/closes, and realized PnL diagnostics are internally consistent.",
        nextFix: "apps/worker/src/taker/TakerLoop.ts"
      },
      () => runTakerChecks(ctx)
    )
  );
  checks.push(
    runCheckSafely(
      ctx,
      {
        code: "D",
        checkName: "shadow-synthetic-fill-sanity",
        hypothesis:
          "Synthetic fills are bounded, explainable, and not materially biasing markout diagnostics.",
        nextFix: "apps/worker/src/shadow/ShadowExecutionLoop.ts"
      },
      () => runSyntheticChecks(ctx)
    )
  );

  const overallVerdict = computeOverallVerdict(checks);

  const manifestPath = relPath(
    writeJsonFile(path.join(runOutDir, "doctor-run.json"), {
      runId,
      runTs,
      dbPath,
      ledgerPath: ledgerPath,
      outDir: runOutDir,
      quick,
      strict,
      hours,
      horizonMs,
      anchorTs,
      sinceTs,
      gitHash: git,
      configHash: cfgHash,
      overallVerdict,
      checks
    })
  );

  if (ledger) {
    for (const check of checks) {
      appendLedgerEntry(ledger, {
        runId,
        runTs,
        gitHash: git,
        configHash: cfgHash,
        checkName: `${check.code}.${check.checkName}`,
        hypothesis: check.hypothesis,
        paramsJson: stableJsonStringify({
          dbPath,
          hours,
          horizonMs,
          strict,
          quick,
          sinceTs,
          anchorTs
        }),
        sampleJson: stableJsonStringify(check.counts),
        resultsJson: stableJsonStringify({
          warnings: check.warnings,
          failures: check.failures,
          artifacts: check.artifacts
        }),
        verdict: checkToLedgerVerdict(check.verdict),
        nextAction: check.failures[0]?.nextFix ?? null,
        artifactsPath: check.artifacts[0] ?? manifestPath
      });
    }
    appendLedgerEntry(ledger, {
      runId,
      runTs,
      gitHash: git,
      configHash: cfgHash,
      checkName: "RUN.doctor-suite",
      hypothesis: "Doctor run-level sweep point over selected (hours, horizonMs, strict, quick) parameters.",
      paramsJson: stableJsonStringify({
        dbPath,
        hours,
        horizonMs,
        strict,
        quick,
        sinceTs,
        anchorTs
      }),
      sampleJson: stableJsonStringify({
        checks: checks.length,
        failed_checks: checks.filter((check) => check.verdict === "fail").length,
        inconclusive_checks: checks.filter((check) => check.verdict === "inconclusive").length
      }),
      resultsJson: stableJsonStringify({
        overallVerdict,
        runArtifacts: [manifestPath]
      }),
      verdict: checkToLedgerVerdict(overallVerdict),
      nextAction:
        checks.find((check) => check.verdict === "fail")?.failures[0]?.nextFix ??
        checks.find((check) => check.verdict === "inconclusive")?.failures[0]?.nextFix ??
        null,
      artifactsPath: manifestPath
    });
  }

  safeClose(sqlite);
  if (ledger) safeClose(ledger);

  return {
    runId,
    runTs,
    dbPath,
    ledgerPath: options.skipLedger ? null : ledgerPath,
    outDir: runOutDir,
    quick,
    strict,
    hours,
    horizonMs,
    anchorTs,
    sinceTs,
    gitHash: git,
    configHash: cfgHash,
    overallVerdict,
    checks,
    runArtifacts: [manifestPath]
  };
}

export function parseDoctorArgs(argv: string[] = process.argv.slice(2)): DoctorRunOptions & { json: boolean } {
  const args = parseCliArgs(argv);
  const hoursRaw = Number(args.get("hours") ?? 24);
  const horizonRaw = Number(args.get("horizonMs") ?? 600_000);
  return {
    dbPath: args.get("db"),
    ledgerPath: args.get("ledger"),
    hours: Number.isFinite(hoursRaw) ? hoursRaw : 24,
    horizonMs: Number.isFinite(horizonRaw) ? horizonRaw : 600_000,
    strict: args.get("strict") === "true" || args.get("strict") === "1" || args.has("strict"),
    outDir: args.get("outDir"),
    runId: args.get("runId"),
    quick: args.get("quick") === "true" || args.get("quick") === "1" || args.has("quick"),
    skipLedger: args.get("skipLedger") === "true" || args.get("skipLedger") === "1" || args.has("skipLedger"),
    json: args.get("json") === "true" || args.get("json") === "1" || args.has("json")
  };
}

export function renderDoctorText(result: DoctorRunResult): string {
  const lines: string[] = [];
  lines.push(`Run ID: ${result.runId}`);
  lines.push(`DB: ${result.dbPath}`);
  lines.push(`Ledger: ${result.ledgerPath ?? "(disabled)"}`);
  lines.push(`Window: since=${result.sinceTs} anchor=${result.anchorTs} hours=${result.hours}`);
  lines.push(`Horizon: ${result.horizonMs} ms`);
  lines.push(`Mode: ${result.quick ? "quick" : "full"}${result.strict ? " + strict" : ""}`);
  lines.push("");
  lines.push("Check | Verdict | Key Counts");
  lines.push("----- | ------- | ----------");
  for (const check of result.checks) {
    const keyCounts = Object.entries(check.counts)
      .slice(0, 4)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ");
    lines.push(`${check.code} ${check.checkName} | ${check.verdict.toUpperCase()} | ${keyCounts}`);
  }

  for (const check of result.checks) {
    if (check.verdict !== "fail") continue;
    lines.push("");
    lines.push(`[${check.code}] ${check.checkName} failures:`);
    for (const failure of check.failures) {
      lines.push(`Symptom: ${failure.symptom}`);
      lines.push(`Why: ${failure.why}`);
      lines.push(`Likely causes: ${failure.likelyCauses.join(" | ")}`);
      lines.push(`Next fix: ${failure.nextFix}`);
      lines.push(`Repro artifact: ${failure.reproArtifact ?? "(none)"}`);
      lines.push(`Validation command: ${failure.validationCommand}`);
      lines.push("");
    }
  }

  for (const check of result.checks) {
    if (check.warnings.length === 0) continue;
    lines.push(`[${check.code}] warnings: ${check.warnings.join(" | ")}`);
  }

  lines.push("");
  lines.push(`Overall: ${result.overallVerdict.toUpperCase()}`);
  lines.push(`Artifacts: ${result.runArtifacts.join(", ")}`);
  return lines.join("\n");
}
