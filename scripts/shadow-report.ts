#!/usr/bin/env npx tsx
/**
 * Shadow execution report: fill realism + markouts.
 * Usage: npx tsx scripts/shadow-report.ts
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../packages/storage/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const dbPath = process.env.DB_PATH
  ? path.isAbsolute(process.env.DB_PATH)
    ? process.env.DB_PATH
    : path.join(repoRoot, process.env.DB_PATH)
  : path.join(repoRoot, "data", "dev.db");

const hours = Number(process.env.SHADOW_REPORT_HOURS ?? 24);
const now = Date.now();
const since = now - hours * 60 * 60 * 1000;

const { sqlite } = openDatabase(dbPath);

const countShadowOrders = sqlite
  .prepare(
    `SELECT kind, COUNT(*) as c
     FROM shadow_orders
     WHERE ts >= ?
     GROUP BY kind`
  )
  .all(since) as Array<{ kind: string; c: number }>;

const countShadowFills = sqlite
  .prepare(
    `SELECT o.kind as kind, COUNT(*) as c
     FROM shadow_fills f
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE f.ts >= ?
     GROUP BY o.kind`
  )
  .all(since) as Array<{ kind: string; c: number }>;

const makerOrders = countShadowOrders
  .filter((r) => r.kind === "MAKER_BID" || r.kind === "MAKER_ASK")
  .reduce((acc, r) => acc + r.c, 0);
const makerFills = countShadowFills
  .filter((r) => r.kind === "MAKER_BID" || r.kind === "MAKER_ASK")
  .reduce((acc, r) => acc + r.c, 0);

const takerOrders = countShadowOrders
  .filter((r) => r.kind === "TAKER_BUY" || r.kind === "TAKER_SELL")
  .reduce((acc, r) => acc + r.c, 0);
const takerFills = countShadowFills
  .filter((r) => r.kind === "TAKER_BUY" || r.kind === "TAKER_SELL")
  .reduce((acc, r) => acc + r.c, 0);

const makerFillRate = makerOrders > 0 ? makerFills / makerOrders : 0;
const takerFillRate = takerOrders > 0 ? takerFills / takerOrders : 0;

const markouts = sqlite
  .prepare(
    `SELECT horizon_ms as horizonMs, markout_bps as markoutBps
     FROM shadow_markouts
     WHERE ts >= ?`
  )
  .all(since) as Array<{ horizonMs: number; markoutBps: number | null }>;

const groupByHorizon = new Map<number, number[]>();
for (const row of markouts) {
  if (row.markoutBps == null || !Number.isFinite(row.markoutBps)) continue;
  const list = groupByHorizon.get(row.horizonMs) ?? [];
  list.push(row.markoutBps);
  groupByHorizon.set(row.horizonMs, list);
}

const percentile = (vals: number[], p: number): number | null => {
  if (!vals.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
  return sorted[idx] ?? null;
};

const avg = (vals: number[]): number | null =>
  vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;

console.log(`[shadow-report] DB: ${dbPath}`);
console.log(`[shadow-report] window: last ${hours}h`);
console.log(`[shadow-report] maker orders: ${makerOrders} fills: ${makerFills} fill_rate: ${(makerFillRate * 100).toFixed(2)}%`);
console.log(`[shadow-report] taker orders: ${takerOrders} fills: ${takerFills} fill_rate: ${(takerFillRate * 100).toFixed(2)}%`);

if (groupByHorizon.size === 0) {
  console.log("[shadow-report] markouts: none in window");
} else {
  console.log("[shadow-report] markouts (bps):");
  const horizons = Array.from(groupByHorizon.keys()).sort((a, b) => a - b);
  for (const h of horizons) {
    const vals = groupByHorizon.get(h) ?? [];
    const mean = avg(vals);
    const p50 = percentile(vals, 0.5);
    const p25 = percentile(vals, 0.25);
    const p75 = percentile(vals, 0.75);
    console.log(
      `  - ${h}ms: n=${vals.length} avg=${mean?.toFixed(2)} p25=${p25?.toFixed(2)} p50=${p50?.toFixed(2)} p75=${p75?.toFixed(2)}`
    );
  }
}

sqlite.close();
