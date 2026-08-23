#!/usr/bin/env tsx
/**
 * Correctness Migration (one-time)
 *
 * Runs in order:
 * 1) Reset maker state (destructive)
 * 2) Cleanup NULL mid/spread features (batched)
 * 3) Run decision-only invariants
 *
 * Usage:
 *   npx tsx scripts/archive/manual-diagnostics/migrate-correctness.ts --confirm
 *   npx tsx scripts/archive/manual-diagnostics/migrate-correctness.ts --confirm --no-reset
 *   npx tsx scripts/archive/manual-diagnostics/migrate-correctness.ts --confirm --batch=250000
 */

import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const dbPath = process.env.DB_PATH ?? path.join(repoRoot, "data", "dev.db");

const confirmed = process.argv.includes("--confirm");
const noReset = process.argv.includes("--no-reset");
if (!confirmed) {
  console.error("Refusing to run without --confirm");
  process.exit(1);
}

const batchArg = process.argv.find((arg) => arg.startsWith("--batch="));
const batchSize = batchArg ? Number(batchArg.split("=")[1]) : 250000;
const limit = Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 250000;

const db = new Database(dbPath);
db.pragma("busy_timeout = 60000");

function resetMakerState(): void {
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

  const txn = db.transaction(() => {
    for (const table of tables) {
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
        if (res.changes === 0) break;
      }
      console.log(`Deleted ${total} rows from ${table} (${batches} batches)`);
    }
    for (const table of resetSeqTables) {
      db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
    }
  });

  txn();
}

function cleanupNullFeatures(): { deleted: number; batches: number; latestDeleted: number } {
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
  while (true) {
    const res = deleteFeaturesStmt.run(limit);
    totalDeleted += res.changes;
    batches += 1;
    if (res.changes === 0) break;
  }

  const latestRes = deleteLatestStmt.run();
  return { deleted: totalDeleted, batches, latestDeleted: latestRes.changes };
}

console.log("Correctness Migration");
console.log(`Database: ${dbPath}`);

if (!noReset) {
  console.log("Step 1: Resetting maker state...");
  resetMakerState();
  console.log("✅ Maker state reset");
} else {
  console.log("Step 1: Skipped maker reset (--no-reset)");
}

console.log(`Step 2: Cleaning NULL features (batch=${limit})...`);
const cleanup = cleanupNullFeatures();
console.log(`✅ Deleted features=${cleanup.deleted} latest_features=${cleanup.latestDeleted} batches=${cleanup.batches}`);

db.close();

console.log("Step 3: Running decision-only invariants...");
const invariantScripts = [
  "scripts/invariants/no-signal-schema.ts",
  "scripts/invariants/decision-chain-integrity.ts",
  "scripts/invariants/decisionedge-contract.ts",
  "scripts/invariants/decision-log-append-only.ts"
];

for (const scriptPath of invariantScripts) {
  const result = spawnSync("npx", ["tsx", scriptPath, "--db", dbPath], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env }
  });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("✅ Decision-only invariants passed");
