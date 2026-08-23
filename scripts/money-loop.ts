#!/usr/bin/env tsx

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  boolArg,
  discoverDbPath,
  numberArg,
  openReadOnlyDatabase,
  parseCliArgs,
  resolveRepoRoot,
  safeClose,
  stringArg
} from "./lib/db.js";

type WorkerRuntimeConfig = {
  taker?: {
    enabled?: boolean;
    minNetEdgeBps?: number;
  };
  makerEv?: {
    minExpectedEvBps?: number;
    quoteHalfSpreadBps?: number;
    quoteSize?: number;
    maxNotionalPerOrderUsd?: number;
    maxInventoryAbs?: number;
    inventoryLambdaBps?: number;
    tradeFlowGate?: {
      staleCancelAgeSec?: number;
    };
  };
  arb?: {
    enabled?: boolean;
    minNetEdgeBps?: number;
  };
  regimeGating?: {
    enabled?: boolean;
    failOpen?: boolean;
  };
  regimeReport?: {
    enabled?: boolean;
  };
};

type ThresholdCandidate = {
  thresholdBps: number;
  count: number;
  coverage: number;
  avgBps: number;
  wavgBps: number;
  upliftAvgBps: number;
  upliftWavgBps: number;
  pass: boolean;
  failReasons: string[];
};

type MakerSideSummary = {
  kind: "MAKER_BID" | "MAKER_ASK";
  markoutCount: number;
  avgBps: number | null;
  wavgBps: number | null;
};

type ArbThresholdCandidate = {
  thresholdBps: number;
  count: number;
  coverage: number;
  avgNetEdgeBps: number;
  robustAvgNetEdgeBps: number;
  executionCount: number;
  executionConversion: number;
  successRate: number;
  realizedPnl: number;
  score: number;
  pass: boolean;
  failReasons: string[];
};

type MoneyLoopReport = {
  generatedAtIso: string;
  dbPath: string;
  configPath: string;
  windowHours: number;
  horizonMs: number;
  currentConfig: {
    takerEnabled: boolean;
    takerMinNetEdgeBps: number;
    makerMinExpectedEvBps: number;
    makerQuoteHalfSpreadBps: number;
    makerQuoteSize: number;
    makerMaxNotionalPerOrderUsd: number;
    makerMaxInventoryAbs: number;
    makerInventoryLambdaBps: number;
    makerStaleCancelAgeSec: number;
    arbEnabled: boolean;
    arbMinNetEdgeBps: number;
  };
  baseline: {
    takerCount: number;
    takerAvgBps: number;
    takerWavgBps: number;
    makerHorizonMs: number;
    makerOrders: number;
    makerRealFills: number;
    makerFillRate: number;
    makerMarkoutCount: number;
    makerAvgBps: number | null;
    makerWavgBps: number | null;
    makerBySide: MakerSideSummary[];
    arbOppCount: number;
    arbAvgNetEdgeBps: number | null;
    arbRobustAvgNetEdgeBps: number | null;
    arbExecutionOppCount: number;
    arbExecutionConversion: number;
    arbSuccessRate: number;
    arbRealizedPnl: number;
  };
  takerSweep: ThresholdCandidate[];
  arbSweep: ArbThresholdCandidate[];
  recommendation: {
    takerEnabled: boolean;
    takerMinNetEdgeBps: number;
    makerMinExpectedEvBps: number;
    makerQuoteHalfSpreadBps: number;
    makerQuoteSize: number;
    makerMaxNotionalPerOrderUsd: number;
    makerMaxInventoryAbs: number;
    makerInventoryLambdaBps: number;
    makerStaleCancelAgeSec: number;
    arbEnabled: boolean;
    arbMinNetEdgeBps: number;
    reasons: string[];
  };
  applyConfig: boolean;
  configUpdated: boolean;
  outputFiles: {
    json: string;
    markdown: string;
  };
};

type TakerRow = {
  netEdgeBps: number | null;
  markoutBps: number | null;
  weight: number | null;
};

type MakerMarkoutRow = {
  kind: "MAKER_BID" | "MAKER_ASK";
  markoutCount: number;
  avgBps: number | null;
  wavgBps: number | null;
};

type ArbOpportunityRow = {
  opportunityId: number;
  netEdgeBps: number | null;
  executionStatus: string | null;
  realizedPnl: number | null;
};

const fmtPct = (v: number): string => `${(v * 100).toFixed(2)}%`;
const fmtBps = (v: number | null): string => (v == null || !Number.isFinite(v) ? "n/a" : `${v.toFixed(3)} bps`);
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const toRunId = (now: Date): string => now.toISOString().replace(/[:.]/g, "-");

const weighted = (rows: Array<{ bps: number; weight: number }>): { avgBps: number; wavgBps: number } => {
  if (!rows.length) return { avgBps: 0, wavgBps: 0 };
  let sum = 0;
  let sumW = 0;
  let sumWBps = 0;
  for (const row of rows) {
    sum += row.bps;
    if (Number.isFinite(row.weight) && row.weight > 0) {
      sumW += row.weight;
      sumWBps += row.bps * row.weight;
    }
  }
  return {
    avgBps: sum / rows.length,
    wavgBps: sumW > 0 ? sumWBps / sumW : sum / rows.length
  };
};

const parseThresholds = (raw: string): number[] =>
  raw
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v))
    .map((v) => Math.max(0, v))
    .sort((a, b) => a - b);

const roundToBucket = (value: number, bucket = 50): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value / bucket) * bucket);
};

const quantile = (sorted: number[], q: number): number => {
  if (!sorted.length) return 0;
  const p = Math.max(0, Math.min(1, q));
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? 0;
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? loVal;
  return loVal + (idx - lo) * (hiVal - loVal);
};

const winsorizeValues = (values: number[], lowerQ: number, upperQ: number): number[] => {
  if (!values.length) return [];
  const loQ = Math.max(0, Math.min(0.49, lowerQ));
  const hiQ = Math.max(loQ + 0.01, Math.min(1, upperQ));
  const sorted = [...values].sort((a, b) => a - b);
  const lo = quantile(sorted, loQ);
  const hi = quantile(sorted, hiQ);
  return values.map((v) => clamp(v, lo, hi));
};

const trimmedMean = (values: number[], trimQ: number): number => {
  if (!values.length) return 0;
  const q = Math.max(0, Math.min(0.3, trimQ));
  const sorted = [...values].sort((a, b) => a - b);
  const trimN = Math.floor(sorted.length * q);
  const start = trimN;
  const end = sorted.length - trimN;
  const core = end > start ? sorted.slice(start, end) : sorted;
  const sum = core.reduce((acc, v) => acc + v, 0);
  return core.length > 0 ? sum / core.length : 0;
};

const robustMean = (values: number[], winsorQ: number, trimQ: number): number => {
  if (!values.length) return 0;
  return trimmedMean(winsorizeValues(values, winsorQ, 1 - winsorQ), trimQ);
};

const uniqueSorted = (values: number[]): number[] =>
  [...new Set(values.filter((v) => Number.isFinite(v)).map((v) => Math.max(0, v)))]
    .sort((a, b) => a - b);

const deriveAdaptiveThresholds = (values: number[], currentThreshold: number, bucket = 50): number[] => {
  if (!values.length) return uniqueSorted([roundToBucket(currentThreshold, bucket)]);
  const sorted = [...values].sort((a, b) => a - b);
  const percentiles = [0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9];
  const candidates = percentiles.map((p) => roundToBucket(quantile(sorted, p), bucket));
  const p95 = roundToBucket(quantile(sorted, 0.95), bucket);
  candidates.push(roundToBucket(currentThreshold, bucket), p95);
  return uniqueSorted(candidates);
};

const readWorkerConfig = (configPath: string): WorkerRuntimeConfig => {
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as WorkerRuntimeConfig;
  } catch {
    return {};
  }
};

const writeWorkerConfig = (configPath: string, config: WorkerRuntimeConfig): void => {
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
};

const toMarkdown = (report: MoneyLoopReport): string => {
  const sweepLines = report.takerSweep.map((row) => {
    const reason = row.pass ? "ok" : row.failReasons.join("|");
    return `- th=${row.thresholdBps}bps n=${row.count} cov=${fmtPct(row.coverage)} avg=${row.avgBps.toFixed(
      3
    )} wavg=${row.wavgBps.toFixed(3)} uplift=${row.upliftAvgBps.toFixed(3)} ${row.pass ? "PASS" : "FAIL"} (${reason})`;
  });
  const arbSweepLines = report.arbSweep.map((row) => {
    const reason = row.pass ? "ok" : row.failReasons.join("|");
    return `- th=${row.thresholdBps}bps n=${row.count} cov=${fmtPct(row.coverage)} avg_edge=${row.avgNetEdgeBps.toFixed(
      3
    )} robust_edge=${row.robustAvgNetEdgeBps.toFixed(3)} exec_conv=${fmtPct(row.executionConversion)} success=${fmtPct(
      row.successRate
    )} score=${row.score.toFixed(3)} ${row.pass ? "PASS" : "FAIL"} (${reason})`;
  });
  const makerSideLines = report.baseline.makerBySide.map(
    (row) => `- ${row.kind}: n=${row.markoutCount} avg=${fmtBps(row.avgBps)} wavg=${fmtBps(row.wavgBps)}`
  );
  const reasonLines = report.recommendation.reasons.map((r) => `- ${r}`);

  return [
    `# Money Loop`,
    ``,
    `- generated_at: ${report.generatedAtIso}`,
    `- db_path: ${report.dbPath}`,
    `- config_path: ${report.configPath}`,
    `- window_hours: ${report.windowHours}`,
    `- horizon_ms: ${report.horizonMs}`,
    `- apply_config: ${String(report.applyConfig)}`,
    `- config_updated: ${String(report.configUpdated)}`,
    ``,
    `## Baseline`,
    `- taker_count: ${report.baseline.takerCount}`,
    `- taker_avg_bps: ${report.baseline.takerAvgBps.toFixed(3)}`,
    `- taker_wavg_bps: ${report.baseline.takerWavgBps.toFixed(3)}`,
    `- maker_horizon_ms: ${report.baseline.makerHorizonMs}`,
    `- maker_orders: ${report.baseline.makerOrders}`,
    `- maker_real_fills: ${report.baseline.makerRealFills}`,
    `- maker_fill_rate: ${fmtPct(report.baseline.makerFillRate)}`,
    `- maker_markout_count: ${report.baseline.makerMarkoutCount}`,
    `- maker_avg_bps: ${fmtBps(report.baseline.makerAvgBps)}`,
    `- maker_wavg_bps: ${fmtBps(report.baseline.makerWavgBps)}`,
    `- arb_opportunity_count: ${report.baseline.arbOppCount}`,
    `- arb_avg_net_edge_bps: ${fmtBps(report.baseline.arbAvgNetEdgeBps)}`,
    `- arb_robust_avg_net_edge_bps: ${fmtBps(report.baseline.arbRobustAvgNetEdgeBps)}`,
    `- arb_execution_opp_count: ${report.baseline.arbExecutionOppCount}`,
    `- arb_execution_conversion: ${fmtPct(report.baseline.arbExecutionConversion)}`,
    `- arb_success_rate: ${fmtPct(report.baseline.arbSuccessRate)}`,
    `- arb_realized_pnl: ${report.baseline.arbRealizedPnl.toFixed(4)}`,
    ``,
    `## Maker Sides`,
    ...(makerSideLines.length ? makerSideLines : ["- none"]),
    ``,
    `## Taker Sweep`,
    ...(sweepLines.length ? sweepLines : ["- none"]),
    ``,
    `## Arb Sweep`,
    ...(arbSweepLines.length ? arbSweepLines : ["- none"]),
    ``,
    `## Recommendation`,
    `- taker.enabled: ${String(report.recommendation.takerEnabled)}`,
    `- taker.minNetEdgeBps: ${report.recommendation.takerMinNetEdgeBps}`,
    `- makerEv.minExpectedEvBps: ${report.recommendation.makerMinExpectedEvBps}`,
    `- makerEv.quoteHalfSpreadBps: ${report.recommendation.makerQuoteHalfSpreadBps}`,
    `- makerEv.quoteSize: ${report.recommendation.makerQuoteSize}`,
    `- makerEv.maxNotionalPerOrderUsd: ${report.recommendation.makerMaxNotionalPerOrderUsd}`,
    `- makerEv.maxInventoryAbs: ${report.recommendation.makerMaxInventoryAbs}`,
    `- makerEv.inventoryLambdaBps: ${report.recommendation.makerInventoryLambdaBps}`,
    `- makerEv.tradeFlowGate.staleCancelAgeSec: ${report.recommendation.makerStaleCancelAgeSec}`,
    `- arb.enabled: ${String(report.recommendation.arbEnabled)}`,
    `- arb.minNetEdgeBps: ${report.recommendation.arbMinNetEdgeBps}`,
    ...(reasonLines.length ? reasonLines : ["- none"]),
    ``
  ].join("\n");
};

function main(): void {
  const args = parseCliArgs();
  const repoRoot = resolveRepoRoot();
  const now = new Date();
  const runId = toRunId(now);

  const dbPath = discoverDbPath(stringArg(args, "db", ""));
  const configPath = path.join(repoRoot, "configs", "worker.json");
  const windowHours = Math.max(1, numberArg(args, "hours", 48));
  const horizonMs = Math.max(1_000, numberArg(args, "horizon-ms", 300_000));
  const makerHorizonMs = Math.max(1_000, numberArg(args, "maker-horizon-ms", 30_000));
  const applyConfig = boolArg(args, "apply-config", true);
  const runEvidence = boolArg(args, "run-evidence", true);

  const makerMinFillRate = Math.max(0, numberArg(args, "maker-min-fill-rate", 0.01));
  const makerMinRealFills = Math.max(0, Math.floor(numberArg(args, "maker-min-real-fills", 20)));
  const makerMinSideMarkouts = Math.max(1, Math.floor(numberArg(args, "maker-min-side-markouts", 20)));
  const makerMinWavgBps = numberArg(args, "maker-min-wavg-bps", 0);
  const makerTuneMinMarkouts = Math.max(20, Math.floor(numberArg(args, "maker-tune-min-markouts", 200)));
  const makerPositiveWavgBps = numberArg(args, "maker-positive-wavg-bps", 10);
  const makerEvStepUp = Math.max(0.01, numberArg(args, "maker-ev-step-up", 0.25));
  const makerEvStepDown = Math.max(0.01, numberArg(args, "maker-ev-step-down", 0.1));
  const makerSpreadStepUp = Math.max(0.1, numberArg(args, "maker-spread-step-up", 1));
  const makerSpreadStepDown = Math.max(0.1, numberArg(args, "maker-spread-step-down", 0.5));
  const makerSizeScaleDown = clamp(numberArg(args, "maker-size-scale-down", 0.9), 0.5, 0.99);
  const makerSizeScaleUp = clamp(numberArg(args, "maker-size-scale-up", 1.05), 1.01, 1.5);
  const makerEvMin = Math.max(0, numberArg(args, "maker-ev-min", 0.25));
  const makerEvMax = Math.max(makerEvMin, numberArg(args, "maker-ev-max", 8));
  const makerSpreadMin = Math.max(0.1, numberArg(args, "maker-spread-min", 4));
  const makerSpreadMax = Math.max(makerSpreadMin, numberArg(args, "maker-spread-max", 30));
  const makerSizeMin = Math.max(1, numberArg(args, "maker-size-min", 10));
  const makerSizeMax = Math.max(makerSizeMin, numberArg(args, "maker-size-max", 200));
  const makerNotionalScaleDown = clamp(numberArg(args, "maker-notional-scale-down", 0.85), 0.5, 0.99);
  const makerNotionalScaleUp = clamp(numberArg(args, "maker-notional-scale-up", 1.05), 1.01, 1.5);
  const makerInventoryCapScaleDown = clamp(numberArg(args, "maker-inventory-cap-scale-down", 0.9), 0.5, 0.99);
  const makerInventoryCapScaleUp = clamp(numberArg(args, "maker-inventory-cap-scale-up", 1.05), 1.01, 1.5);
  const makerInventoryLambdaStepUp = Math.max(0.1, numberArg(args, "maker-inventory-lambda-step-up", 1));
  const makerInventoryLambdaStepDown = Math.max(0.1, numberArg(args, "maker-inventory-lambda-step-down", 0.5));
  const makerStaleCancelAgeScaleDown = clamp(numberArg(args, "maker-stale-cancel-age-scale-down", 0.85), 0.5, 0.99);
  const makerStaleCancelAgeScaleUp = clamp(numberArg(args, "maker-stale-cancel-age-scale-up", 1.05), 1.01, 2);
  const makerNotionalMin = Math.max(1, numberArg(args, "maker-notional-min", 10));
  const makerNotionalMax = Math.max(makerNotionalMin, numberArg(args, "maker-notional-max", 300));
  const makerInventoryAbsMin = Math.max(1, numberArg(args, "maker-inventory-abs-min", 50));
  const makerInventoryAbsMax = Math.max(makerInventoryAbsMin, numberArg(args, "maker-inventory-abs-max", 2_000));
  const makerInventoryLambdaMin = Math.max(0.1, numberArg(args, "maker-inventory-lambda-min", 1));
  const makerInventoryLambdaMax = Math.max(makerInventoryLambdaMin, numberArg(args, "maker-inventory-lambda-max", 50));
  const makerStaleCancelAgeMin = Math.max(1, numberArg(args, "maker-stale-cancel-age-min", 5));
  const makerStaleCancelAgeMax = Math.max(
    makerStaleCancelAgeMin,
    numberArg(args, "maker-stale-cancel-age-max", 120)
  );

  const takerMinSamples = Math.max(1, Math.floor(numberArg(args, "taker-min-samples", 200)));
  const takerMinCoverage = Math.max(0, Math.min(1, numberArg(args, "taker-min-coverage", 0.2)));
  const takerMinAvgBps = numberArg(args, "taker-min-avg-bps", 0);
  const takerMinWavgBps = numberArg(args, "taker-min-wavg-bps", 0);
  const takerMinUpliftBps = numberArg(args, "taker-min-uplift-bps", 0.1);
  const takerMinUpliftWavgBps = numberArg(args, "taker-min-uplift-wavg-bps", 0);
  const thresholdsRaw = stringArg(args, "thresholds", "");
  const thresholds = thresholdsRaw.trim().length > 0 ? parseThresholds(thresholdsRaw) : [];
  const arbThresholdsRaw = stringArg(args, "arb-thresholds", "");
  const arbThresholds = arbThresholdsRaw.trim().length > 0 ? parseThresholds(arbThresholdsRaw) : [];
  const arbThresholdBucket = Math.max(1, Math.floor(numberArg(args, "arb-threshold-bucket", 50)));
  const arbMinOpps = Math.max(1, Math.floor(numberArg(args, "arb-min-opps", 5)));
  const arbMinCoverage = Math.max(0, Math.min(1, numberArg(args, "arb-min-coverage", 0.2)));
  const arbMinMeanEdgeBps = numberArg(args, "arb-min-mean-edge-bps", 3);
  const arbStepBps = Math.max(1, Math.floor(numberArg(args, "arb-step-bps", 2)));
  const arbMinExecutionConversion = Math.max(
    0,
    Math.min(1, numberArg(args, "arb-min-execution-conversion", 0.1))
  );
  const arbMinSuccessRate = Math.max(0, Math.min(1, numberArg(args, "arb-min-success-rate", 0.5)));
  const arbMinExecutionSamples = Math.max(
    1,
    Math.floor(numberArg(args, "arb-min-execution-samples", 5))
  );
  const arbEdgeWinsorQ = Math.max(0, Math.min(0.2, numberArg(args, "arb-edge-winsor-q", 0.1)));
  const arbEdgeTrimQ = Math.max(0, Math.min(0.2, numberArg(args, "arb-edge-trim-q", 0.1)));

  const workerConfig = readWorkerConfig(configPath);
  const current = {
    takerEnabled: workerConfig.taker?.enabled ?? false,
    takerMinNetEdgeBps: workerConfig.taker?.minNetEdgeBps ?? 0,
    makerMinExpectedEvBps: workerConfig.makerEv?.minExpectedEvBps ?? 0.5,
    makerQuoteHalfSpreadBps: workerConfig.makerEv?.quoteHalfSpreadBps ?? 8,
    makerQuoteSize: workerConfig.makerEv?.quoteSize ?? 50,
    makerMaxNotionalPerOrderUsd: workerConfig.makerEv?.maxNotionalPerOrderUsd ?? 100,
    makerMaxInventoryAbs: workerConfig.makerEv?.maxInventoryAbs ?? 500,
    makerInventoryLambdaBps: workerConfig.makerEv?.inventoryLambdaBps ?? 10,
    makerStaleCancelAgeSec: workerConfig.makerEv?.tradeFlowGate?.staleCancelAgeSec ?? 45,
    arbEnabled: workerConfig.arb?.enabled ?? false,
    arbMinNetEdgeBps: workerConfig.arb?.minNetEdgeBps ?? 3
  };

  const sinceTs = Date.now() - windowHours * 60 * 60 * 1000;
  const sqlite = openReadOnlyDatabase(dbPath);

  try {
    const takerRows = sqlite
      .prepare(
        `SELECT
           o.net_edge_bps as netEdgeBps,
           m.markout_bps as markoutBps,
           (COALESCE(NULLIF(m.mid_at_fill, 0), NULLIF(f.price, 0), 0.5) * COALESCE(NULLIF(f.size, 0), 1)) as weight
         FROM shadow_markouts m
         JOIN shadow_fills f ON f.id = m.fill_id
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE m.ts >= ?
           AND m.horizon_ms = ?
           AND o.execution_mode = 'SHADOW'
           AND o.kind IN ('TAKER_BUY', 'TAKER_SELL')
           AND m.markout_bps IS NOT NULL`
      )
      .all(sinceTs, horizonMs) as TakerRow[];

    const takerClean = takerRows.map((row) => ({
      netEdgeBps: Number.isFinite(row.netEdgeBps ?? NaN) ? (row.netEdgeBps as number) : null,
      bps: row.markoutBps as number,
      weight: Number.isFinite(row.weight ?? NaN) ? (row.weight as number) : 0
    }));
    const baseline = weighted(takerClean.map((row) => ({ bps: row.bps, weight: row.weight })));
    const netEdgeValues = takerClean
      .map((row) => row.netEdgeBps)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const thresholdCandidates = thresholds.length > 0
      ? thresholds
      : deriveAdaptiveThresholds(netEdgeValues, current.takerMinNetEdgeBps);

    const sweep: ThresholdCandidate[] = thresholdCandidates.map((thresholdBps) => {
      const selected = takerClean.filter((row) => row.netEdgeBps != null && row.netEdgeBps >= thresholdBps);
      const m = weighted(selected.map((row) => ({ bps: row.bps, weight: row.weight })));
      const coverage = takerClean.length > 0 ? selected.length / takerClean.length : 0;
      const upliftAvgBps = m.avgBps - baseline.avgBps;
      const upliftWavgBps = m.wavgBps - baseline.wavgBps;
      const failReasons: string[] = [];
      if (selected.length < takerMinSamples) failReasons.push(`count_lt_${takerMinSamples}`);
      if (coverage < takerMinCoverage) failReasons.push(`coverage_lt_${takerMinCoverage}`);
      if (m.avgBps < takerMinAvgBps) failReasons.push(`avg_lt_${takerMinAvgBps}`);
      if (m.wavgBps < takerMinWavgBps) failReasons.push(`wavg_lt_${takerMinWavgBps}`);
      if (upliftAvgBps < takerMinUpliftBps) failReasons.push(`uplift_lt_${takerMinUpliftBps}`);
      if (upliftWavgBps < takerMinUpliftWavgBps) failReasons.push(`uplift_wavg_lt_${takerMinUpliftWavgBps}`);
      return {
        thresholdBps,
        count: selected.length,
        coverage,
        avgBps: m.avgBps,
        wavgBps: m.wavgBps,
        upliftAvgBps,
        upliftWavgBps,
        pass: failReasons.length === 0,
        failReasons
      };
    });

    const bestTaker = sweep
      .filter((row) => row.pass)
      .sort((a, b) => (b.wavgBps - a.wavgBps) || (b.avgBps - a.avgBps) || (b.count - a.count))[0] ?? null;

    const makerOrders = (
      sqlite
        .prepare(
          `SELECT COUNT(*) as c
           FROM shadow_orders
           WHERE ts >= ?
             AND execution_mode = 'SHADOW'
             AND kind IN ('MAKER_BID', 'MAKER_ASK')`
        )
        .get(sinceTs) as { c: number }
    ).c;
    const makerRealFills = (
      sqlite
        .prepare(
          `SELECT COUNT(*) as c
           FROM shadow_fills f
           JOIN shadow_orders o ON o.id = f.order_id
           WHERE f.ts >= ?
             AND o.execution_mode = 'SHADOW'
             AND o.kind IN ('MAKER_BID', 'MAKER_ASK')
             AND (f.method IS NULL OR f.method != 'synthetic_fill')`
        )
        .get(sinceTs) as { c: number }
    ).c;
    const makerFillRate = makerOrders > 0 ? makerRealFills / makerOrders : 0;

    const makerRows = sqlite
      .prepare(
        `SELECT
           o.kind as kind,
           COUNT(*) as markoutCount,
           AVG(m.markout_bps) as avgBps,
           SUM(m.markout_bps * (COALESCE(NULLIF(m.mid_at_fill, 0), NULLIF(f.price, 0), 0.5) * COALESCE(NULLIF(f.size, 0), 1)))
             / NULLIF(SUM(COALESCE(NULLIF(m.mid_at_fill, 0), NULLIF(f.price, 0), 0.5) * COALESCE(NULLIF(f.size, 0), 1)), 0) as wavgBps
         FROM shadow_markouts m
         JOIN shadow_fills f ON f.id = m.fill_id
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE m.ts >= ?
           AND m.horizon_ms = ?
           AND o.execution_mode = 'SHADOW'
           AND o.kind IN ('MAKER_BID', 'MAKER_ASK')
           AND m.markout_bps IS NOT NULL
         GROUP BY o.kind`
      )
      .all(sinceTs, makerHorizonMs) as MakerMarkoutRow[];

    const makerBySide: MakerSideSummary[] = ["MAKER_BID", "MAKER_ASK"].map((kind) => {
      const found = makerRows.find((row) => row.kind === kind);
      return {
        kind,
        markoutCount: found?.markoutCount ?? 0,
        avgBps: Number.isFinite(found?.avgBps ?? NaN) ? (found?.avgBps as number) : null,
        wavgBps: Number.isFinite(found?.wavgBps ?? NaN) ? (found?.wavgBps as number) : null
      };
    });

    const makerAggregateRows: Array<{ bps: number; weight: number }> = [];
    const makerMarkoutRows = sqlite
      .prepare(
        `SELECT
           m.markout_bps as markoutBps,
           (COALESCE(NULLIF(m.mid_at_fill, 0), NULLIF(f.price, 0), 0.5) * COALESCE(NULLIF(f.size, 0), 1)) as weight
         FROM shadow_markouts m
         JOIN shadow_fills f ON f.id = m.fill_id
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE m.ts >= ?
           AND m.horizon_ms = ?
           AND o.execution_mode = 'SHADOW'
           AND o.kind IN ('MAKER_BID', 'MAKER_ASK')
           AND m.markout_bps IS NOT NULL`
      )
      .all(sinceTs, makerHorizonMs) as Array<{ markoutBps: number; weight: number }>;
    for (const row of makerMarkoutRows) {
      makerAggregateRows.push({ bps: row.markoutBps, weight: row.weight });
    }
    const makerAggregate = weighted(makerAggregateRows);

    const arbRows = sqlite
      .prepare(
        `SELECT
           o.id as opportunityId,
           o.net_edge_bps as netEdgeBps,
           ex.status as executionStatus,
           ex.realized_pnl as realizedPnl
         FROM arb_opportunities o
         LEFT JOIN (
           SELECT e1.opportunity_id as opportunityId,
                  e1.status as status,
                  e1.realized_pnl as realized_pnl
           FROM arb_executions e1
           JOIN (
             SELECT opportunity_id, MAX(id) as maxId
             FROM arb_executions
             GROUP BY opportunity_id
           ) latest ON latest.maxId = e1.id
         ) ex ON ex.opportunityId = o.id
         WHERE o.ts >= ?
           AND o.net_edge_bps IS NOT NULL`
      )
      .all(sinceTs) as ArbOpportunityRow[];
    const arbNetEdges = arbRows
      .map((row) => row.netEdgeBps)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const arbAvgNetEdgeBps = arbNetEdges.length > 0
      ? arbNetEdges.reduce((sum, value) => sum + value, 0) / arbNetEdges.length
      : null;
    const arbRobustAvgNetEdgeBps = arbNetEdges.length > 0
      ? robustMean(arbNetEdges, arbEdgeWinsorQ, arbEdgeTrimQ)
      : null;
    const arbExecutionRows = arbRows.filter((row) => typeof row.executionStatus === "string");
    const arbExecutionOppCount = arbExecutionRows.length;
    const arbExecutionConversion = arbRows.length > 0 ? arbExecutionOppCount / arbRows.length : 0;
    const arbSuccessCount = arbExecutionRows.filter((row) =>
      row.executionStatus === "SUBMITTED" || row.executionStatus === "PARTIAL" || row.executionStatus === "FILLED"
    ).length;
    const arbSuccessRate = arbExecutionOppCount > 0 ? arbSuccessCount / arbExecutionOppCount : 0;
    const arbRealizedPnl = arbExecutionRows
      .map((row) => row.realizedPnl)
      .filter((v): v is number => v != null && Number.isFinite(v))
      .reduce((sum, value) => sum + value, 0);
    const arbThresholdCandidates = arbThresholds.length > 0
      ? arbThresholds
      : deriveAdaptiveThresholds(arbNetEdges, current.arbMinNetEdgeBps, arbThresholdBucket);
    const arbSweep: ArbThresholdCandidate[] = arbThresholdCandidates.map((thresholdBps) => {
      const selectedRows = arbRows.filter((row) => (row.netEdgeBps ?? -Infinity) >= thresholdBps);
      const selectedEdges = selectedRows
        .map((row) => row.netEdgeBps)
        .filter((v): v is number => v != null && Number.isFinite(v));
      const coverage = arbRows.length > 0 ? selectedRows.length / arbRows.length : 0;
      const avgNetEdgeBps =
        selectedEdges.length > 0 ? selectedEdges.reduce((sum, edge) => sum + edge, 0) / selectedEdges.length : 0;
      const robustAvgNetEdgeBps = selectedEdges.length > 0
        ? robustMean(selectedEdges, arbEdgeWinsorQ, arbEdgeTrimQ)
        : 0;
      const executionRows = selectedRows.filter((row) => typeof row.executionStatus === "string");
      const executionCount = executionRows.length;
      const executionConversion = selectedRows.length > 0 ? executionCount / selectedRows.length : 0;
      const successCount = executionRows.filter((row) =>
        row.executionStatus === "SUBMITTED" || row.executionStatus === "PARTIAL" || row.executionStatus === "FILLED"
      ).length;
      const successRate = executionCount > 0 ? successCount / executionCount : 0;
      const realizedPnl = executionRows
        .map((row) => row.realizedPnl)
        .filter((v): v is number => v != null && Number.isFinite(v))
        .reduce((sum, value) => sum + value, 0);
      const score = robustAvgNetEdgeBps * (0.25 + executionConversion) * (0.25 + coverage);
      const failReasons: string[] = [];
      if (selectedRows.length < arbMinOpps) failReasons.push(`count_lt_${arbMinOpps}`);
      if (coverage < arbMinCoverage) failReasons.push(`coverage_lt_${arbMinCoverage}`);
      if (robustAvgNetEdgeBps < arbMinMeanEdgeBps) failReasons.push(`robust_avg_edge_lt_${arbMinMeanEdgeBps}`);
      if (arbExecutionOppCount >= arbMinExecutionSamples && executionConversion < arbMinExecutionConversion) {
        failReasons.push(`exec_conv_lt_${arbMinExecutionConversion}`);
      }
      if (executionCount >= arbMinExecutionSamples && successRate < arbMinSuccessRate) {
        failReasons.push(`success_rate_lt_${arbMinSuccessRate}`);
      }
      return {
        thresholdBps,
        count: selectedRows.length,
        coverage,
        avgNetEdgeBps,
        robustAvgNetEdgeBps,
        executionCount,
        executionConversion,
        successRate,
        realizedPnl,
        score,
        pass: failReasons.length === 0,
        failReasons
      };
    });
    const bestArb = arbSweep
      .filter((row) => row.pass)
      .sort(
        (a, b) =>
          (b.score - a.score) ||
          (b.robustAvgNetEdgeBps - a.robustAvgNetEdgeBps) ||
          (b.executionConversion - a.executionConversion) ||
          (b.count - a.count) ||
          (b.thresholdBps - a.thresholdBps)
      )[0] ?? null;

    const reasons: string[] = [];
    reasons.push(
      `taker threshold candidates (${thresholds.length > 0 ? "cli" : "adaptive_quantiles"}): ${
        thresholdCandidates.length > 0 ? thresholdCandidates.join(",") : "none"
      }`
    );

    const takerEnabled = true;
    const takerMinNetEdgeBps = bestTaker != null ? bestTaker.thresholdBps : current.takerMinNetEdgeBps;
    reasons.push(
      bestTaker
        ? `taker ON (policy): best threshold=${takerMinNetEdgeBps}bps avg=${bestTaker.avgBps.toFixed(3)}bps wavg=${bestTaker.wavgBps.toFixed(3)}bps uplift_wavg=${bestTaker.upliftWavgBps.toFixed(3)}bps coverage=${fmtPct(bestTaker.coverage)}`
        : "taker ON (policy): no profitable threshold found yet; keeping current threshold"
    );

    const makerHealthPass = makerFillRate >= makerMinFillRate && makerRealFills >= makerMinRealFills;
    const makerEdgePass = makerAggregate.wavgBps >= makerMinWavgBps;
    const bid = makerBySide.find((row) => row.kind === "MAKER_BID");
    const ask = makerBySide.find((row) => row.kind === "MAKER_ASK");
    const bidGood = (bid?.markoutCount ?? 0) >= makerMinSideMarkouts && (bid?.wavgBps ?? -Infinity) > 0;
    const askGood = (ask?.markoutCount ?? 0) >= makerMinSideMarkouts && (ask?.wavgBps ?? -Infinity) > 0;
    const bidBad = (bid?.markoutCount ?? 0) >= makerMinSideMarkouts && (bid?.wavgBps ?? Infinity) <= makerMinWavgBps;
    const askBad = (ask?.markoutCount ?? 0) >= makerMinSideMarkouts && (ask?.wavgBps ?? Infinity) <= makerMinWavgBps;
    const sideStatus = bidGood && askGood
      ? "both_sides_positive"
      : bidGood
        ? "bid_side_positive"
        : askGood
          ? "ask_side_positive"
          : "neither_side_positive";

    let makerMinExpectedEvBps = current.makerMinExpectedEvBps;
    let makerQuoteHalfSpreadBps = current.makerQuoteHalfSpreadBps;
    let makerQuoteSize = current.makerQuoteSize;
    let makerMaxNotionalPerOrderUsd = current.makerMaxNotionalPerOrderUsd;
    let makerMaxInventoryAbs = current.makerMaxInventoryAbs;
    let makerInventoryLambdaBps = current.makerInventoryLambdaBps;
    let makerStaleCancelAgeSec = current.makerStaleCancelAgeSec;
    let makerTuneMode = "hold";

    if (makerAggregateRows.length < makerTuneMinMarkouts) {
      reasons.push(
        `maker HOLD: insufficient markouts (${makerAggregateRows.length}/${makerTuneMinMarkouts}) for auto-tuning (horizon=${makerHorizonMs}ms)`
      );
    } else if (!makerHealthPass || !makerEdgePass || bidBad || askBad) {
      makerTuneMode = "defensive";
      const sidePenalty = (bidBad ? 1 : 0) + (askBad ? 1 : 0);
      makerMinExpectedEvBps = clamp(
        makerMinExpectedEvBps + makerEvStepUp * (1 + sidePenalty * 0.5),
        makerEvMin,
        makerEvMax
      );
      makerQuoteHalfSpreadBps = clamp(
        makerQuoteHalfSpreadBps + makerSpreadStepUp * (1 + sidePenalty * 0.5),
        makerSpreadMin,
        makerSpreadMax
      );
      makerQuoteSize = clamp(
        makerQuoteSize * makerSizeScaleDown,
        makerSizeMin,
        makerSizeMax
      );
      reasons.push(
        `maker DEFENSIVE: health/edge weak (fills=${makerRealFills}/${makerMinRealFills}, fill_rate=${fmtPct(
          makerFillRate
        )}/${fmtPct(makerMinFillRate)}, wavg=${makerAggregate.wavgBps.toFixed(3)}bps floor=${makerMinWavgBps.toFixed(3)}bps, side_status=${sideStatus})`
      );

      const coreSaturated = makerMinExpectedEvBps >= makerEvMax && makerQuoteHalfSpreadBps >= makerSpreadMax &&
        makerQuoteSize <= makerSizeMin;
      const severeLoss = makerAggregate.wavgBps <= makerMinWavgBps - 5;
      if (coreSaturated && severeLoss) {
        const before = {
          maxNotionalPerOrderUsd: makerMaxNotionalPerOrderUsd,
          maxInventoryAbs: makerMaxInventoryAbs,
          inventoryLambdaBps: makerInventoryLambdaBps,
          staleCancelAgeSec: makerStaleCancelAgeSec
        };
        makerMaxNotionalPerOrderUsd = clamp(
          makerMaxNotionalPerOrderUsd * makerNotionalScaleDown,
          makerNotionalMin,
          makerNotionalMax
        );
        makerMaxInventoryAbs = clamp(
          makerMaxInventoryAbs * makerInventoryCapScaleDown,
          makerInventoryAbsMin,
          makerInventoryAbsMax
        );
        makerInventoryLambdaBps = clamp(
          makerInventoryLambdaBps + makerInventoryLambdaStepUp,
          makerInventoryLambdaMin,
          makerInventoryLambdaMax
        );
        makerStaleCancelAgeSec = clamp(
          makerStaleCancelAgeSec * makerStaleCancelAgeScaleDown,
          makerStaleCancelAgeMin,
          makerStaleCancelAgeMax
        );
        reasons.push(
          `maker SATURATION_THROTTLE: capped core controls with persistent loss, risk budget tightened (maxNotional ${before.maxNotionalPerOrderUsd.toFixed(
            2
          )}->${makerMaxNotionalPerOrderUsd.toFixed(2)}, maxInventory ${before.maxInventoryAbs.toFixed(
            2
          )}->${makerMaxInventoryAbs.toFixed(2)}, inventoryLambda ${before.inventoryLambdaBps.toFixed(
            2
          )}->${makerInventoryLambdaBps.toFixed(2)}, staleCancelAge ${before.staleCancelAgeSec.toFixed(
            2
          )}->${makerStaleCancelAgeSec.toFixed(2)})`
        );
      }
    } else if (makerAggregate.wavgBps >= makerPositiveWavgBps && makerFillRate >= makerMinFillRate * 1.5) {
      makerTuneMode = "expand";
      makerMinExpectedEvBps = clamp(
        makerMinExpectedEvBps - makerEvStepDown,
        makerEvMin,
        makerEvMax
      );
      makerQuoteHalfSpreadBps = clamp(
        makerQuoteHalfSpreadBps - makerSpreadStepDown,
        makerSpreadMin,
        makerSpreadMax
      );
      makerQuoteSize = clamp(
        makerQuoteSize * makerSizeScaleUp,
        makerSizeMin,
        makerSizeMax
      );
      makerMaxNotionalPerOrderUsd = clamp(
        makerMaxNotionalPerOrderUsd * makerNotionalScaleUp,
        makerNotionalMin,
        makerNotionalMax
      );
      makerMaxInventoryAbs = clamp(
        makerMaxInventoryAbs * makerInventoryCapScaleUp,
        makerInventoryAbsMin,
        makerInventoryAbsMax
      );
      makerInventoryLambdaBps = clamp(
        makerInventoryLambdaBps - makerInventoryLambdaStepDown,
        makerInventoryLambdaMin,
        makerInventoryLambdaMax
      );
      makerStaleCancelAgeSec = clamp(
        makerStaleCancelAgeSec * makerStaleCancelAgeScaleUp,
        makerStaleCancelAgeMin,
        makerStaleCancelAgeMax
      );
      reasons.push(
        `maker EXPAND: strong edge (fills=${makerRealFills}, fill_rate=${fmtPct(
          makerFillRate
        )}, wavg=${makerAggregate.wavgBps.toFixed(3)}bps, side_status=${sideStatus})`
      );
    } else {
      reasons.push(
        `maker HOLD: mixed edge (fills=${makerRealFills}, fill_rate=${fmtPct(
          makerFillRate
        )}, wavg=${makerAggregate.wavgBps.toFixed(3)}bps, side_status=${sideStatus})`
      );
    }

    makerMinExpectedEvBps = Number(makerMinExpectedEvBps.toFixed(4));
    makerQuoteHalfSpreadBps = Number(makerQuoteHalfSpreadBps.toFixed(4));
    makerQuoteSize = Number(makerQuoteSize.toFixed(4));
    makerMaxNotionalPerOrderUsd = Number(makerMaxNotionalPerOrderUsd.toFixed(4));
    makerMaxInventoryAbs = Number(makerMaxInventoryAbs.toFixed(4));
    makerInventoryLambdaBps = Number(makerInventoryLambdaBps.toFixed(4));
    makerStaleCancelAgeSec = Number(makerStaleCancelAgeSec.toFixed(4));

    if (makerHealthPass && makerEdgePass) {
      reasons.push(
        `maker health pass (fills=${makerRealFills}, fill_rate=${fmtPct(makerFillRate)}, wavg=${makerAggregate.wavgBps.toFixed(3)}bps, side_status=${sideStatus}, tune_mode=${makerTuneMode})`
      );
    } else {
      reasons.push(
        `maker health fail (fills=${makerRealFills}/${makerMinRealFills}, fill_rate=${fmtPct(
          makerFillRate
        )}/${fmtPct(makerMinFillRate)}, wavg=${makerAggregate.wavgBps.toFixed(3)}bps floor=${makerMinWavgBps.toFixed(3)}bps)`
      );
    }

    reasons.push(
      `arb baseline: opps=${arbNetEdges.length} exec_opps=${arbExecutionOppCount} exec_conv=${fmtPct(
        arbExecutionConversion
      )} success=${fmtPct(arbSuccessRate)} avg_edge=${arbAvgNetEdgeBps == null ? "n/a" : `${arbAvgNetEdgeBps.toFixed(
        3
      )}bps`} robust_edge=${
        arbRobustAvgNetEdgeBps == null ? "n/a" : `${arbRobustAvgNetEdgeBps.toFixed(3)}bps`
      } realized_pnl=${arbRealizedPnl.toFixed(4)}`
    );

    reasons.push(
      `arb threshold candidates (${arbThresholds.length > 0 ? "cli" : "adaptive_quantiles"}): ${
        arbThresholdCandidates.length > 0 ? arbThresholdCandidates.join(",") : "none"
      }`
    );

    const arbEnabled = true;
    let arbMinNetEdgeBps = current.arbMinNetEdgeBps;
    if (arbNetEdges.length === 0) {
      arbMinNetEdgeBps = Math.max(1, arbMinNetEdgeBps - arbStepBps);
      reasons.push(
        `arb ON (explore): no opportunities in window, lowering minNetEdge by ${arbStepBps}bps to ${arbMinNetEdgeBps}bps`
      );
    } else if (bestArb) {
      const target = bestArb.thresholdBps;
      if (target > arbMinNetEdgeBps) {
        arbMinNetEdgeBps = Math.min(arbMinNetEdgeBps + arbStepBps, target);
      } else if (target < arbMinNetEdgeBps) {
        arbMinNetEdgeBps = Math.max(target, arbMinNetEdgeBps - arbStepBps);
      }
      reasons.push(
        `arb ON (policy): target threshold=${target}bps stepped to ${arbMinNetEdgeBps}bps robust_edge=${bestArb.robustAvgNetEdgeBps.toFixed(
          3
        )}bps avg_edge=${bestArb.avgNetEdgeBps.toFixed(3)}bps exec_conv=${fmtPct(bestArb.executionConversion)} success=${fmtPct(
          bestArb.successRate
        )} coverage=${fmtPct(bestArb.coverage)} score=${bestArb.score.toFixed(3)}`
      );
    } else {
      reasons.push(
        `arb ON (hold): no threshold met constraints (min_opps=${arbMinOpps}, min_coverage=${fmtPct(
          arbMinCoverage
        )}, min_robust_edge=${arbMinMeanEdgeBps}bps, min_exec_conv=${fmtPct(
          arbMinExecutionConversion
        )}, min_success=${fmtPct(arbMinSuccessRate)})`
      );
    }
    arbMinNetEdgeBps = Math.max(1, Math.round(arbMinNetEdgeBps));

    const recommendation = {
      takerEnabled,
      takerMinNetEdgeBps,
      makerMinExpectedEvBps,
      makerQuoteHalfSpreadBps,
      makerQuoteSize,
      makerMaxNotionalPerOrderUsd,
      makerMaxInventoryAbs,
      makerInventoryLambdaBps,
      makerStaleCancelAgeSec,
      arbEnabled,
      arbMinNetEdgeBps,
      reasons
    };

    let configUpdated = false;
    if (applyConfig) {
      const next: WorkerRuntimeConfig = {
        ...workerConfig,
        taker: {
          ...(workerConfig.taker ?? {}),
          enabled: recommendation.takerEnabled,
          minNetEdgeBps: recommendation.takerMinNetEdgeBps
        },
        makerEv: {
          ...(workerConfig.makerEv ?? {}),
          minExpectedEvBps: recommendation.makerMinExpectedEvBps,
          quoteHalfSpreadBps: recommendation.makerQuoteHalfSpreadBps,
          quoteSize: recommendation.makerQuoteSize,
          maxNotionalPerOrderUsd: recommendation.makerMaxNotionalPerOrderUsd,
          maxInventoryAbs: recommendation.makerMaxInventoryAbs,
          inventoryLambdaBps: recommendation.makerInventoryLambdaBps,
          tradeFlowGate: {
            ...(workerConfig.makerEv?.tradeFlowGate ?? {}),
            staleCancelAgeSec: recommendation.makerStaleCancelAgeSec
          }
        },
        arb: {
          ...(workerConfig.arb ?? {}),
          enabled: recommendation.arbEnabled,
          minNetEdgeBps: recommendation.arbMinNetEdgeBps
        },
        regimeGating: {
          ...(workerConfig.regimeGating ?? {}),
          enabled: true
        },
        regimeReport: {
          ...(workerConfig.regimeReport ?? {}),
          enabled: true
        }
      };
      const before = JSON.stringify(workerConfig);
      const after = JSON.stringify(next);
      if (before !== after) {
        writeWorkerConfig(configPath, next);
        configUpdated = true;
      }
    }

    const report: MoneyLoopReport = {
      generatedAtIso: now.toISOString(),
      dbPath,
      configPath,
      windowHours,
      horizonMs,
      currentConfig: current,
      baseline: {
        takerCount: takerClean.length,
        takerAvgBps: baseline.avgBps,
        takerWavgBps: baseline.wavgBps,
        makerHorizonMs,
        makerOrders,
        makerRealFills,
        makerFillRate,
        makerMarkoutCount: makerAggregateRows.length,
        makerAvgBps: makerAggregateRows.length > 0 ? makerAggregate.avgBps : null,
        makerWavgBps: makerAggregateRows.length > 0 ? makerAggregate.wavgBps : null,
        makerBySide,
        arbOppCount: arbNetEdges.length,
        arbAvgNetEdgeBps: arbAvgNetEdgeBps,
        arbRobustAvgNetEdgeBps: arbRobustAvgNetEdgeBps,
        arbExecutionOppCount,
        arbExecutionConversion,
        arbSuccessRate,
        arbRealizedPnl
      },
      takerSweep: sweep,
      arbSweep,
      recommendation,
      applyConfig,
      configUpdated,
      outputFiles: {
        json: "",
        markdown: ""
      }
    };

    const outDir = path.join(repoRoot, "reports", "money-loop", runId);
    mkdirSync(outDir, { recursive: true });
    const jsonPath = path.join(outDir, "report.json");
    const markdownPath = path.join(outDir, "report.md");
    report.outputFiles.json = jsonPath;
    report.outputFiles.markdown = markdownPath;
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    writeFileSync(markdownPath, `${toMarkdown(report)}\n`, "utf-8");

    console.log(`[money-loop] wrote ${jsonPath}`);
    console.log(`[money-loop] wrote ${markdownPath}`);
    console.log(
      `[money-loop] recommendation taker.enabled=${recommendation.takerEnabled} taker.minNetEdgeBps=${recommendation.takerMinNetEdgeBps} makerEv.minExpectedEvBps=${recommendation.makerMinExpectedEvBps} makerEv.quoteHalfSpreadBps=${recommendation.makerQuoteHalfSpreadBps} makerEv.quoteSize=${recommendation.makerQuoteSize} makerEv.maxNotionalPerOrderUsd=${recommendation.makerMaxNotionalPerOrderUsd} makerEv.maxInventoryAbs=${recommendation.makerMaxInventoryAbs} makerEv.inventoryLambdaBps=${recommendation.makerInventoryLambdaBps} makerEv.tradeFlowGate.staleCancelAgeSec=${recommendation.makerStaleCancelAgeSec} arb.enabled=${recommendation.arbEnabled} arb.minNetEdgeBps=${recommendation.arbMinNetEdgeBps}`
    );
    if (applyConfig) {
      console.log(`[money-loop] config ${configUpdated ? "updated" : "unchanged"} at ${configPath}`);
    }

    if (runEvidence) {
      const evidence = spawnSync(
        "npx",
        ["tsx", "scripts/evidence-pack.ts", "--phase", "burn-in", "--skip-tests", "--strict=false"],
        { cwd: repoRoot, encoding: "utf-8", timeout: 15 * 60_000 }
      );
      if (evidence.stdout?.trim()) {
        console.log(evidence.stdout.trim());
      }
      if (evidence.stderr?.trim()) {
        console.error(evidence.stderr.trim());
      }
      console.log(
        `[money-loop] evidence-pack exit=${evidence.status == null ? "null" : evidence.status}`
      );
    }
  } finally {
    safeClose(sqlite);
  }
}

main();
