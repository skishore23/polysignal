#!/usr/bin/env npx tsx
/**
 * Shadow gap report by wallet.
 * Usage: npx tsx scripts/shadow-gap-report.ts
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

const wallets = sqlite
  .prepare("SELECT id, name, maker_enabled, auto_trade_enabled FROM wallets")
  .all() as Array<{ id: number; name: string; maker_enabled: number; auto_trade_enabled: number }>;

const makerShadowOrdersStmt = sqlite.prepare(
  `SELECT COUNT(*) as c FROM shadow_orders
   WHERE wallet_id = ? AND kind IN ('MAKER_BID','MAKER_ASK') AND ts >= ?`
);
const makerShadowFillsStmt = sqlite.prepare(
  `SELECT COUNT(*) as c
   FROM shadow_fills f
   JOIN shadow_orders o ON o.id = f.order_id
   WHERE o.wallet_id = ? AND o.kind IN ('MAKER_BID','MAKER_ASK') AND f.ts >= ?`
);
const makerMarkoutStmt = sqlite.prepare(
  `SELECT AVG(m.markout_bps) as avg_bps
   FROM shadow_markouts m
   JOIN shadow_fills f ON f.id = m.fill_id
   JOIN shadow_orders o ON o.id = f.order_id
   WHERE o.wallet_id = ? AND o.kind IN ('MAKER_BID','MAKER_ASK')
     AND m.horizon_ms = ? AND m.ts >= ?`
);

const takerShadowOrdersStmt = sqlite.prepare(
  `SELECT COUNT(*) as c FROM shadow_orders
   WHERE wallet_id = ? AND kind IN ('TAKER_BUY','TAKER_SELL') AND ts >= ?`
);
const takerShadowFillsStmt = sqlite.prepare(
  `SELECT COUNT(*) as c
   FROM shadow_fills f
   JOIN shadow_orders o ON o.id = f.order_id
   WHERE o.wallet_id = ? AND o.kind IN ('TAKER_BUY','TAKER_SELL') AND f.ts >= ?`
);
const takerMarkoutStmt = sqlite.prepare(
  `SELECT AVG(m.markout_bps) as avg_bps
   FROM shadow_markouts m
   JOIN shadow_fills f ON f.id = m.fill_id
   JOIN shadow_orders o ON o.id = f.order_id
   WHERE o.wallet_id = ? AND o.kind IN ('TAKER_BUY','TAKER_SELL')
     AND m.horizon_ms = ? AND m.ts >= ?`
);

const horizons = [1000, 5000, 30000, 300000];

console.log(`[shadow-gap] DB: ${dbPath}`);
console.log(`[shadow-gap] window: last ${hours}h`);

for (const w of wallets) {
  if (!w.maker_enabled && !w.auto_trade_enabled) continue;

  const makerOrders = (makerShadowOrdersStmt.get(w.id, since) as { c: number }).c;
  const makerFills = (makerShadowFillsStmt.get(w.id, since) as { c: number }).c;
  const makerFillRate = makerOrders > 0 ? makerFills / makerOrders : 0;
  const takerOrders = (takerShadowOrdersStmt.get(w.id, since) as { c: number }).c;
  const takerFills = (takerShadowFillsStmt.get(w.id, since) as { c: number }).c;
  const takerFillRate = takerOrders > 0 ? takerFills / takerOrders : 0;

  console.log(`\n[wallet] ${w.id} ${w.name}`);
  if (w.maker_enabled) {
    console.log(
      `  maker shadow orders=${makerOrders} fills=${makerFills} fill_rate=${(makerFillRate * 100).toFixed(2)}%`
    );
    for (const h of horizons) {
      const row = makerMarkoutStmt.get(w.id, h, since) as { avg_bps: number | null };
      if (row?.avg_bps != null) {
        console.log(`  maker markout ${h}ms avg_bps=${row.avg_bps.toFixed(2)}`);
      }
    }
  }
  if (w.auto_trade_enabled) {
    console.log(
      `  taker shadow orders=${takerOrders} fills=${takerFills} fill_rate=${(takerFillRate * 100).toFixed(2)}%`
    );
    for (const h of horizons) {
      const row = takerMarkoutStmt.get(w.id, h, since) as { avg_bps: number | null };
      if (row?.avg_bps != null) {
        console.log(`  taker markout ${h}ms avg_bps=${row.avg_bps.toFixed(2)}`);
      }
    }
  }
}

sqlite.close();
