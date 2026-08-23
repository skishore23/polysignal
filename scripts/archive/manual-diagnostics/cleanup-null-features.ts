#!/usr/bin/env tsx
/**
 * Cleanup NULL Feature Rows
 *
 * Deletes rows with NULL mid/spread in controlled batches.
 * Safe to run multiple times.
 *
 * Usage:
 *   npx tsx scripts/archive/manual-diagnostics/cleanup-null-features.ts --confirm
 *   npx tsx scripts/archive/manual-diagnostics/cleanup-null-features.ts --confirm --batch=250000
 *   npx tsx scripts/archive/manual-diagnostics/cleanup-null-features.ts --confirm --batch=250000 --max-batches=10
 */

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ?? path.join(__dirname, "..", "data", "dev.db");

const confirmed = process.argv.includes("--confirm");
if (!confirmed) {
  console.error("Refusing to delete rows without --confirm");
  process.exit(1);
}

const batchArg = process.argv.find((arg) => arg.startsWith("--batch="));
const batchSize = batchArg ? Number(batchArg.split("=")[1]) : 250000;
const limit = Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 250000;
const maxBatchesArg = process.argv.find((arg) => arg.startsWith("--max-batches="));
const maxBatches = maxBatchesArg ? Number(maxBatchesArg.split("=")[1]) : Number.POSITIVE_INFINITY;

const db = new Database(dbPath);
db.pragma("busy_timeout = 60000");

const deleteFeaturesStmt = db.prepare(
  `DELETE FROM features
   WHERE id IN (
     SELECT id FROM features
     WHERE mid IS NULL OR spread IS NULL
     LIMIT ?
   )`
);
const deleteLatestStmt = db.prepare(
  `DELETE FROM latest_features WHERE mid IS NULL OR spread IS NULL`
);

let totalDeleted = 0;
let batches = 0;

while (batches < maxBatches) {
  const res = deleteFeaturesStmt.run(limit);
  totalDeleted += res.changes;
  batches += 1;
  console.log(`Batch ${batches}: deleted ${res.changes}`);
  if (res.changes === 0) break;
}

const latestRes = deleteLatestStmt.run();
db.close();

console.log("Cleanup complete");
console.log(`Database: ${dbPath}`);
console.log(`Deleted features: ${totalDeleted}`);
console.log(`Deleted latest_features: ${latestRes.changes}`);
console.log(`Batches: ${batches}${Number.isFinite(maxBatches) ? ` (max ${maxBatches})` : ""}`);
