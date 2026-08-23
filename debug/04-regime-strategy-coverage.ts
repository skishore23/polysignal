/**
 * Diagnostic 04: Regime strategy coverage
 * Strategy report row count; state|kind|wallet combos with orders vs with strategy rows;
 * RegimeGate decision distribution (allow/block/no_row).
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { openDb, getRegimeConfig, repoRoot } from "./shared.js";
import { buildRegimeBase, computeStrategyRegimeReport, lookupStateAt } from "../packages/data/src/index.js";

type OrderRow = {
  id: number;
  ts: number;
  tokenId: string;
  kind: string;
  walletId: number | null;
  stateId: number | null;
};

const config = getRegimeConfig();
const { sqlite, dbPath } = openDb();

console.log(`\n${"=".repeat(60)}`);
console.log("04 REGIME STRATEGY COVERAGE");
console.log(`${"=".repeat(60)}`);
console.log(`DB: ${dbPath}`);
console.log(`Since: ${new Date(config.sinceTs).toISOString()}\n`);

const base = buildRegimeBase(sqlite, config);
const { stateTimelines } = base;

const report = computeStrategyRegimeReport(sqlite, config);
const strategyKeys = new Set(report.rows.map((r) => `${r.state}|${r.kind}|${r.walletId}`));

const orderRows = sqlite
  .prepare(
    `SELECT id, ts, token_id as tokenId, kind, wallet_id as walletId, state_id as stateId
     FROM shadow_orders
     WHERE ts >= ?`
  )
  .all(config.sinceTs) as OrderRow[];

const orderCombosWithState = new Set<string>();
let ordersWithNullState = 0;
let ordersWithStateId = 0;

for (const row of orderRows) {
  let state: number | null = Number.isFinite(row.stateId ?? NaN) ? (row.stateId as number) : null;
  if (state != null) ordersWithStateId++;
  if (state == null) {
    const timeline = stateTimelines.get(row.tokenId);
    state = timeline ? lookupStateAt(timeline, row.ts) : null;
  }
  if (state == null) {
    ordersWithNullState += 1;
    continue;
  }
  const key = `${state}|${row.kind}|${row.walletId ?? -1}`;
  orderCombosWithState.add(key);
}

const combosWithOrdersButNoStrategy = [...orderCombosWithState].filter((k) => !strategyKeys.has(k));

const loadGatingConfig = () => {
  const raw = readFileSync(path.join(repoRoot, "configs", "worker.json"), "utf-8");
  const parsed = JSON.parse(raw) as { regimeGating?: { minCount?: number; minWavgBps?: number; failOpen?: boolean } };
  return parsed.regimeGating ?? {};
};

const gating = loadGatingConfig();
const minCount = Number(gating.minCount ?? 20);
const minWavgBps = Number(gating.minWavgBps ?? 1);
const failOpen = gating.failOpen !== false;

let rowsThatAllow = 0;
let rowsThatBlock = 0;

for (const row of report.rows) {
  if (row.count < minCount) {
    if (failOpen) rowsThatAllow++;
  } else if (row.wavgBps != null && row.wavgBps < minWavgBps) {
    rowsThatBlock++;
  } else {
    rowsThatAllow++;
  }
}

console.log("Strategy report:");
console.log(`  Strategy rows:              ${report.rows.length}`);
console.log(`  Unique state|kind|wallet:   ${strategyKeys.size}`);
console.log("");
console.log("Orders:");
console.log(`  Total orders (in window):   ${orderRows.length}`);
console.log(`  Orders with state_id set:   ${ordersWithStateId} (${orderRows.length > 0 ? ((ordersWithStateId / orderRows.length) * 100).toFixed(1) : "0"}%)`);
console.log(`  Orders with state=null:     ${ordersWithNullState}`);
console.log(`  Order combos (attributed):  ${orderCombosWithState.size}`);
console.log("");
console.log("Coverage:");
console.log(`  Combos with orders but no strategy row: ${combosWithOrdersButNoStrategy.length}`);
if (combosWithOrdersButNoStrategy.length > 0) {
  const sample = combosWithOrdersButNoStrategy.slice(0, 10);
  console.log(`  Sample: ${sample.join("; ")}`);
}
console.log("");
console.log("RegimeGate (for strategy rows only):");
console.log(`  minCount=${minCount} minWavgBps=${minWavgBps} failOpen=${failOpen}`);
console.log(`  Strategy rows that would allow: ${rowsThatAllow}`);
console.log(`  Strategy rows that would block: ${rowsThatBlock}`);
console.log(`  (State|kind|wallet not in strategy report -> no_row -> failOpen)`);

sqlite.close();
console.log("\n");
