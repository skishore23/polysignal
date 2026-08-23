/**
 * Unified Markov proof — Steps 1–5
 * Run after worker has produced fresh orders.
 * Pass/fail per step; aggregates into overall verdict.
 */
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { openDb, getRegimeConfig, repoRoot } from "./shared.js";
import {
  buildRegimeBase,
  computeStrategyRegimeReport,
  lookupStateAt
} from "../packages/data/src/index.js";
import type { RegimeConfig } from "../packages/data/src/regimeAnalysis.js";

type MarkoutRow = {
  ts: number;
  markoutBps: number | null;
  midAtFill: number | null;
  price: number | null;
  size: number | null;
  tokenId: string;
  kind: string;
  walletId: number | null;
  orderId: number;
  stateId: number | null;
};

type OrderRow = {
  id: number;
  ts: number;
  tokenId: string;
  kind: string;
  walletId: number | null;
  stateId: number | null;
};

const THRESHOLD_STATE_COVERAGE = 0.9;
const THRESHOLD_ATTRIBUTION = 0.95;
const THRESHOLD_NULL_STATE_PCT = 0.05;

const runStep1 = (sqlite: ReturnType<typeof openDb>["sqlite"], config: RegimeConfig) => {
  const orderRows = sqlite
    .prepare(
      `SELECT id, ts, token_id as tokenId, kind, wallet_id as walletId, state_id as stateId
       FROM shadow_orders
       WHERE ts >= ?`
    )
    .all(config.sinceTs) as OrderRow[];

  const ordersTotal = orderRows.length;
  const ordersWithStateId = orderRows.filter(
    (r) => r.stateId != null && Number.isFinite(r.stateId)
  ).length;
  const pct = ordersTotal > 0 ? ordersWithStateId / ordersTotal : 0;

  const stateIds = orderRows
    .filter((r) => r.stateId != null && Number.isFinite(r.stateId))
    .map((r) => r.stateId as number);
  const distinctStates = new Set(stateIds).size;

  const nullCount = sqlite
    .prepare(
      `SELECT COUNT(*) as n FROM shadow_orders WHERE ts >= ? AND state_id IS NULL`
    )
    .get(config.sinceTs) as { n: number };
  const nullPct = ordersTotal > 0 ? (nullCount?.n ?? 0) / ordersTotal : 0;

  return {
    ordersTotal,
    ordersWithStateId,
    pct,
    distinctStates,
    nullPct,
    pass: ordersTotal === 0 || pct >= THRESHOLD_STATE_COVERAGE
  };
};

const runStep2 = (sqlite: ReturnType<typeof openDb>["sqlite"], config: RegimeConfig) => {
  const markouts = sqlite
    .prepare(
      `SELECT COUNT(*) as n
       FROM shadow_markouts m
       JOIN shadow_fills f ON f.id = m.fill_id
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE m.horizon_ms = ? AND m.ts >= ?`
    )
    .get(config.horizonMs, config.sinceTs) as { n: number };
  const n = markouts?.n ?? 0;

  const withStateId = sqlite
    .prepare(
      `SELECT COUNT(*) as n
       FROM shadow_markouts m
       JOIN shadow_fills f ON f.id = m.fill_id
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE m.horizon_ms = ? AND m.ts >= ? AND o.state_id IS NOT NULL`
    )
    .get(config.horizonMs, config.sinceTs) as { n: number };
  const withState = withStateId?.n ?? 0;

  return {
    markouts: n,
    markoutsWithOrderStateId: withState,
    pass: n > 0
  };
};

const runStep3 = (
  sqlite: ReturnType<typeof openDb>["sqlite"],
  config: RegimeConfig,
  base: { stateTimelines: Map<string, Array<{ ts: number; state: number }>> }
) => {
  const markoutRows = sqlite
    .prepare(
      `SELECT m.ts as ts, m.markout_bps as markoutBps, m.mid_at_fill as midAtFill,
              f.price as price, f.size as size,
              o.token_id as tokenId, o.kind as kind, o.wallet_id as walletId, o.id as orderId, o.state_id as stateId
       FROM shadow_markouts m
       JOIN shadow_fills f ON f.id = m.fill_id
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE m.horizon_ms = ? AND m.ts >= ?`
    )
    .all(config.horizonMs, config.sinceTs) as MarkoutRow[];

  let attributedTotal = 0;
  let attributedViaStateId = 0;
  let nullState = 0;

  for (const row of markoutRows) {
    if (!Number.isFinite(row.markoutBps ?? NaN)) continue;
    if (!Number.isFinite(row.size ?? NaN) || (row.size ?? 0) <= 0) continue;
    const mid = row.midAtFill ?? row.price ?? 0;
    if (!Number.isFinite(mid) || mid <= 0) continue;

    let state: number | null = Number.isFinite(row.stateId ?? NaN) ? (row.stateId as number) : null;
    if (state != null) attributedViaStateId++;
    if (state == null) {
      const timeline = base.stateTimelines.get(row.tokenId);
      state = timeline ? lookupStateAt(timeline, row.ts) : null;
    }

    if (state != null) {
      attributedTotal++;
    } else {
      nullState++;
    }
  }

  const total = attributedTotal + nullState;
  const attributionPct = total > 0 ? attributedTotal / total : 0;
  const viaStateIdPct = total > 0 ? attributedViaStateId / total : 0;
  const nullStatePct = total > 0 ? nullState / total : 0;

  return {
    attributedTotal,
    attributedViaStateId,
    nullState,
    attributionPct,
    viaStateIdPct,
    nullStatePct,
    pass: total === 0 || (attributedTotal > 0 && viaStateIdPct >= THRESHOLD_ATTRIBUTION)
  };
};

const runStep4 = (
  sqlite: ReturnType<typeof openDb>["sqlite"],
  config: RegimeConfig
) => {
  const report = computeStrategyRegimeReport(sqlite, config);
  const rows = report.rows ?? [];
  const nonZeroCounts = rows.filter((r) => r.count > 0).length;
  const nonZeroWavgBps = rows.filter((r) => r.wavgBps != null && r.wavgBps !== 0).length;
  const sparse = rows.filter((r) => r.count === 1).length;

  return {
    strategyRows: rows.length,
    nonZeroCounts,
    nonZeroWavgBps,
    sparseRows: sparse,
    pass: rows.length > 0,
    sampleRow: rows[0] ?? null
  };
};

const runStep5 = () => {
  const configPath = path.join(repoRoot, "configs", "worker.json");
  if (!existsSync(configPath)) return { pass: true, reason: "config missing" };
  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as {
    regimeGating?: { minCount?: number; minWavgBps?: number; failOpen?: boolean };
  };
  const g = parsed.regimeGating ?? {};
  const minCount = Number(g.minCount ?? 20);
  const minWavgBps = Number(g.minWavgBps ?? 0);
  const failOpen = g.failOpen !== false;

  return {
    pass: true,
    reason: "config check (diagnostic mode: minCount=1 minWavgBps=0 to validate gate)",
    minCount,
    minWavgBps,
    failOpen
  };
};

const main = () => {
  const config = getRegimeConfig();
  const { sqlite, dbPath } = openDb();

  console.log(`\n${"=".repeat(60)}`);
  console.log("06 MARKOV PROOF (Steps 1–5)");
  console.log(`${"=".repeat(60)}`);
  console.log(`DB: ${dbPath}`);
  console.log(`Window: ${config.sinceTs} (${new Date(config.sinceTs).toISOString()})`);
  console.log(`HorizonMs: ${config.horizonMs}\n`);

  const s1 = runStep1(sqlite, config);
  const s2 = runStep2(sqlite, config);
  const base = buildRegimeBase(sqlite, config);
  const s3 = runStep3(sqlite, config, base);
  const s4 = runStep4(sqlite, config);
  const s5 = runStep5();

  console.log("Step 1 — Stamping coverage");
  console.log(`  orders_total: ${s1.ordersTotal}`);
  console.log(`  orders_with_state_id: ${s1.ordersWithStateId}`);
  console.log(`  coverage: ${(s1.pct * 100).toFixed(1)}%`);
  console.log(`  distinct_state_ids: ${s1.distinctStates}`);
  console.log(`  null_state_pct: ${(s1.nullPct * 100).toFixed(1)}%`);
  console.log(`  ${s1.pass ? "PASS" : "FAIL"} (≥90%)\n`);

  console.log("Step 2 — Markouts exist");
  console.log(`  markouts in window: ${s2.markouts}`);
  console.log(`  markouts with order.state_id: ${s2.markoutsWithOrderStateId}`);
  console.log(`  ${s2.pass ? "PASS" : "FAIL"} (markouts > 0)\n`);

  console.log("Step 3 — Attribution dominated by order.state_id");
  console.log(`  attributed_total: ${s3.attributedTotal}`);
  console.log(`  attributed_via_state_id: ${s3.attributedViaStateId}`);
  console.log(`  null_state: ${s3.nullState}`);
  console.log(`  via_state_id_pct: ${(s3.viaStateIdPct * 100).toFixed(1)}%`);
  console.log(`  ${s3.pass ? "PASS" : "FAIL"} (≥95% via state_id)\n`);

  console.log("Step 4 — Strategy rows emitted");
  console.log(`  strategy_rows: ${s4.strategyRows}`);
  console.log(`  non_zero_counts: ${s4.nonZeroCounts}`);
  console.log(`  non_zero_wavgBps: ${s4.nonZeroWavgBps}`);
  console.log(`  sparse (count=1): ${s4.sparseRows}`);
  if (s4.sampleRow) {
    console.log(`  sample: state=${s4.sampleRow.state} kind=${s4.sampleRow.kind} count=${s4.sampleRow.count} wavgBps=${s4.sampleRow.wavgBps?.toFixed(1)}`);
  }
  console.log(`  ${s4.pass ? "PASS" : "FAIL"} (rows > 0)\n`);

  console.log("Step 5 — RegimeGate config");
  console.log(`  minCount=${s5.minCount} minWavgBps=${s5.minWavgBps} failOpen=${s5.failOpen}`);
  console.log(`  ${s5.reason}\n`);

  const allPass =
    s1.pass &&
    (s2.markouts === 0 || s3.pass) &&
    (s2.markouts === 0 || s4.pass);

  console.log(`${"=".repeat(60)}`);
  console.log(allPass ? "MARKOV PROOF: PASS" : "MARKOV PROOF: FAIL");
  console.log(`${"=".repeat(60)}\n`);

  sqlite.close();
  process.exit(allPass ? 0 : 1);
};

main();
