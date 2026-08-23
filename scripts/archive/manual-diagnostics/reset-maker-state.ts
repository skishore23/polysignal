#!/usr/bin/env tsx
/**
 * Maker State Reset
 *
 * Wipes maker-related tables so PnL/inventory can rebuild cleanly.
 * This is destructive. Use when you want to start maker accounting fresh.
 *
 * Usage:
 *   npx tsx scripts/archive/manual-diagnostics/reset-maker-state.ts
 *   npx tsx scripts/archive/manual-diagnostics/reset-maker-state.ts --confirm
 *   npx tsx scripts/archive/manual-diagnostics/reset-maker-state.ts --confirm --verbose
 *   npx tsx scripts/archive/manual-diagnostics/reset-maker-state.ts --confirm --batch=250000
 */

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ?? path.join(__dirname, "..", "data", "dev.db");

const confirmed = process.argv.includes("--confirm");
const verbose = process.argv.includes("--verbose");
const batchArg = process.argv.find((arg) => arg.startsWith("--batch="));
const batchSize = batchArg ? Number(batchArg.split("=")[1]) : 250000;
const limit = Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 250000;
if (!confirmed) {
  console.error("Refusing to reset maker state without --confirm");
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma("busy_timeout = 60000");
db.pragma("foreign_keys = OFF");

const tables = [
  "maker_quotes",
  "maker_orders",
  "maker_inventory",
  "maker_rewards",
  "maker_metrics",
  "maker_metrics_latest",
  "maker_fills",
  "maker_pnl",
  "maker_pnl_latest",
  "maker_snapshot_health"
];

const resetSeqTables = [
  "maker_quotes",
  "maker_inventory",
  "maker_rewards",
  "maker_metrics",
  "maker_fills",
  "maker_pnl"
];

function deleteTableInBatches(table: string): number {
  let total = 0;
  let batches = 0;
  while (true) {
    const res = db
      .prepare(
        `DELETE FROM ${table}
         WHERE rowid IN (
           SELECT rowid FROM ${table}
           LIMIT ?
         )`
      )
      .run(limit);
    total += res.changes;
    batches += 1;
    if (verbose) {
      console.log(`Table ${table}: batch ${batches} deleted ${res.changes}`);
    }
    if (res.changes === 0) break;
  }
  return total;
}

const txn = db.transaction(() => {
  for (const table of tables) {
    const total = deleteTableInBatches(table);
    if (!verbose) {
      console.log(`Deleted ${total} rows from ${table}`);
    }
  }
  for (const table of resetSeqTables) {
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
  }
});

txn();
db.close();

console.log("✅ Maker state reset complete");
console.log(`Database: ${dbPath}`);
