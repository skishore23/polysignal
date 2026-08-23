#!/usr/bin/env tsx

import { discoverDbPath, openReadOnlyDatabase, parseCliArgs, safeClose, stringArg } from "../lib/db.js";

type Violation = {
  kind: "table" | "column";
  table: string;
  name: string;
};

const FORBIDDEN_TABLES = ["signals", "latest_signals", "signal_evidence", "hourly_signals"] as const;
const FORBIDDEN_COLUMNS: Array<{ table: string; column: string }> = [
  { table: "shadow_orders", column: "signal_id" },
  { table: "shadow_orders", column: "signal_ts" },
  { table: "shadow_orders", column: "horizon_sec" }
];

const args = parseCliArgs();
const dbPath = discoverDbPath(stringArg(args, "db", ""));
const sqlite = openReadOnlyDatabase(dbPath);

try {
  const violations: Violation[] = [];
  for (const tableName of FORBIDDEN_TABLES) {
    const row = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(tableName) as { name?: string } | undefined;
    if (row?.name === tableName) {
      violations.push({ kind: "table", table: tableName, name: tableName });
    }
  }

  for (const entry of FORBIDDEN_COLUMNS) {
    const columns = sqlite.prepare(`PRAGMA table_info(${entry.table})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === entry.column)) {
      violations.push({ kind: "column", table: entry.table, name: entry.column });
    }
  }

  if (violations.length > 0) {
    console.error(`[invariant:no-signal-schema] FAIL db=${dbPath}`);
    for (const violation of violations) {
      if (violation.kind === "table") {
        console.error(`  - forbidden table exists: ${violation.table}`);
      } else {
        console.error(`  - forbidden column exists: ${violation.table}.${violation.name}`);
      }
    }
    process.exit(1);
  }

  console.log(`[invariant:no-signal-schema] PASS db=${dbPath}`);
} finally {
  safeClose(sqlite);
}
