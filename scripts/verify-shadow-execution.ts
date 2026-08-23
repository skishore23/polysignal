#!/usr/bin/env npx tsx
/**
 * Verify shadow execution tables and basic invariants.
 * Usage: npx tsx scripts/verify-shadow-execution.ts
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

const makerStaleSec = Number(process.env.MAKER_MAX_STALENESS_SEC ?? 120);
const minLatencyMs = 100;
const maxLatencyMs = 500;

const { sqlite } = openDatabase(dbPath);

const tableExists = (name: string): boolean => {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
};

const requiredTables = ["shadow_orders", "shadow_fills"];
const missing = requiredTables.filter((t) => !tableExists(t));
if (missing.length) {
  console.error(`[shadow] Missing tables: ${missing.join(", ")}`);
  process.exit(1);
}

const countOrders = (sqlite.prepare("SELECT COUNT(*) as c FROM shadow_orders").get() as { c: number }).c;
const countFills = (sqlite.prepare("SELECT COUNT(*) as c FROM shadow_fills").get() as { c: number }).c;
let countMarkouts = 0;
if (tableExists("shadow_markouts")) {
  countMarkouts = (sqlite.prepare("SELECT COUNT(*) as c FROM shadow_markouts").get() as { c: number }).c;
} else {
  console.warn("[shadow] shadow_markouts table missing (skipping markout count)");
}

console.log(`[shadow] DB: ${dbPath}`);
console.log(`[shadow] shadow_orders: ${countOrders}`);
console.log(`[shadow] shadow_fills: ${countFills}`);
console.log(`[shadow] shadow_markouts: ${countMarkouts}`);

const kindRows = sqlite
  .prepare("SELECT kind, COUNT(*) as c FROM shadow_orders GROUP BY kind ORDER BY c DESC")
  .all() as Array<{ kind: string; c: number }>;
if (kindRows.length) {
  console.log("[shadow] kinds:");
  for (const row of kindRows) {
    console.log(`  - ${row.kind}: ${row.c}`);
  }
}

const latencyRow = sqlite.prepare(
  `SELECT
     MIN(expected_cancel_ts - ts) as min_ms,
     MAX(expected_cancel_ts - ts) as max_ms
   FROM shadow_orders
   WHERE expected_cancel_ts IS NOT NULL`
).get() as { min_ms: number | null; max_ms: number | null };

if (latencyRow.min_ms == null || latencyRow.max_ms == null) {
  console.warn("[shadow] No expected_cancel_ts found (maker shadow orders missing?)");
} else {
  console.log(`[shadow] cancel latency ms: min=${latencyRow.min_ms} max=${latencyRow.max_ms}`);
  if (latencyRow.min_ms < minLatencyMs || latencyRow.max_ms > maxLatencyMs) {
    console.warn(
      `[shadow] WARNING: latency out of bounds (expected ${minLatencyMs}-${maxLatencyMs}ms)`
    );
  }
}

const staleFeatureCount = (sqlite.prepare(
  "SELECT COUNT(*) as c FROM latest_features WHERE staleness_sec > ?"
).get(makerStaleSec) as { c: number }).c;
console.log(`[shadow] latest_features stale > ${makerStaleSec}s: ${staleFeatureCount}`);

// Best-effort check: if stale features exist, there should be few/no maker shadow orders for those tokens.
const staleMakerOrders = sqlite.prepare(
  `SELECT COUNT(*) as c
   FROM shadow_orders so
   JOIN latest_features lf ON lf.token_id = so.token_id
   WHERE so.kind IN ('MAKER_BID', 'MAKER_ASK')
     AND lf.staleness_sec > ?`
).get(makerStaleSec) as { c: number };

if (staleMakerOrders.c > 0) {
  console.warn(
    `[shadow] WARNING: ${staleMakerOrders.c} maker shadow orders on tokens currently marked stale`
  );
} else {
  console.log("[shadow] maker shadow orders on stale tokens: 0");
}

sqlite.close();
