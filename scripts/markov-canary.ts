#!/usr/bin/env tsx
/**
 * Markov regime canary — fails if coverage/attribution/strategy regress.
 *
 * Run after a short live session. Exit 1 if:
 * - orders_with_state_id < 0.9 * orders_total (orders in regime window)
 * - attributed_via_state_id < 0.9 * attributed_total
 * - markouts > 0 AND strategy_rows == 0
 *
 * Usage: npx tsx scripts/markov-canary.ts
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../packages/storage/src/index.js";
import {
  buildRegimeBase,
  computeStrategyRegimeReport,
  lookupStateAt
} from "../packages/data/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const THRESHOLD_STATE_COVERAGE = 0.9;
const THRESHOLD_ATTRIBUTION = 0.9;

const getRegimeConfig = () => {
  const configPath = path.join(repoRoot, "configs", "worker.json");
  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as { regimeReport?: { hours?: number; horizonMs?: number; bins?: number; stepMs?: number; sampleLimit?: number; features?: string[] } };
  const r = parsed.regimeReport ?? {};
  const hours = Number(r.hours ?? 6);
  const sinceTs = Date.now() - hours * 3600 * 1000;
  return {
    sinceTs,
    horizonMs: Number(r.horizonMs ?? 30_000),
    bins: Number(r.bins ?? 3),
    stepMs: Number(r.stepMs ?? 1000),
    sampleLimit: Number(r.sampleLimit ?? 200_000),
    features: Array.isArray(r.features) ? r.features : ["spread", "depth", "obi", "vol", "micro"]
  };
};

const getDbPath = () => {
  const raw = process.env.DB_PATH ?? "data/dev.db";
  return path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);
};

type OrderRow = { id: number; ts: number; tokenId: string; kind: string; walletId: number | null; stateId: number | null };
type MarkoutRow = { ts: number; markoutBps: number | null; midAtFill: number | null; price: number | null; size: number | null; tokenId: string; kind: string; walletId: number | null; orderId: number; stateId: number | null };

const main = () => {
  const config = getRegimeConfig();
  const dbPath = getDbPath();
  const { sqlite } = openDatabase(dbPath);

  const orderRows = sqlite
    .prepare(
      `SELECT id, ts, token_id as tokenId, kind, wallet_id as walletId, state_id as stateId
       FROM shadow_orders WHERE ts >= ?`
    )
    .all(config.sinceTs) as OrderRow[];

  const ordersTotal = orderRows.length;
  const ordersWithStateId = orderRows.filter((r) => r.stateId != null && Number.isFinite(r.stateId)).length;
  const stateCoverage = ordersTotal > 0 ? ordersWithStateId / ordersTotal : 1;

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

  const base = buildRegimeBase(sqlite, config);
  let attributedTotal = 0;
  let attributedViaStateId = 0;

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
    if (state != null) attributedTotal++;
  }

  const attributionViaStateId = attributedTotal > 0 ? attributedViaStateId / attributedTotal : 1;

  const report = computeStrategyRegimeReport(sqlite, config);
  const strategyRows = report.rows?.length ?? 0;

  sqlite.close();

  const fail1 = ordersTotal > 0 && stateCoverage < THRESHOLD_STATE_COVERAGE;
  const fail2 = attributedTotal > 0 && attributionViaStateId < THRESHOLD_ATTRIBUTION;
  const fail3 = markoutRows.length > 0 && strategyRows === 0;

  if (fail1 || fail2 || fail3) {
    console.error("MARKOV CANARY FAILED");
    if (fail1) {
      console.error(`  orders_with_state_id < 90% of orders_total: ${ordersWithStateId}/${ordersTotal} = ${(stateCoverage * 100).toFixed(1)}%`);
    }
    if (fail2) {
      console.error(`  attributed_via_state_id < 90% of attributed_total: ${attributedViaStateId}/${attributedTotal} = ${(attributionViaStateId * 100).toFixed(1)}%`);
    }
    if (fail3) {
      console.error(`  markouts > 0 AND strategy_rows == 0: markouts=${markoutRows.length} strategy_rows=${strategyRows}`);
    }
    process.exit(1);
  }

  console.log("MARKOV CANARY OK");
  console.log(`  state_id coverage: ${(stateCoverage * 100).toFixed(1)}%`);
  console.log(`  attribution via state_id: ${(attributionViaStateId * 100).toFixed(1)}%`);
  console.log(`  strategy_rows: ${strategyRows}`);
};

main();
