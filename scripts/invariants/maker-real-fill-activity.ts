#!/usr/bin/env tsx

import {
  discoverDbPath,
  numberArg,
  openReadOnlyDatabase,
  parseCliArgs,
  safeClose,
  stringArg,
  tableExists
} from "../lib/db.js";

const args = parseCliArgs();
const dbPath = discoverDbPath(stringArg(args, "db", ""));
const windowHours = Math.max(1, numberArg(args, "window-hours", 24));
const minFillRate = Math.max(0, numberArg(args, "min-fill-rate", 0.02));
const minRealFills = Math.max(0, numberArg(args, "min-real-fills", 20));
const sinceTs = Date.now() - windowHours * 60 * 60 * 1000;

const sqlite = openReadOnlyDatabase(dbPath);

try {
  const requiredTables = ["shadow_orders", "shadow_fills"];
  const missing = requiredTables.filter((tableName) => !tableExists(sqlite, tableName));
  if (missing.length > 0) {
    console.error(`[invariant:maker-real-fill-activity] FAIL db=${dbPath}`);
    console.error(`  - missing tables: ${missing.join(", ")}`);
    process.exit(1);
  }

  let makerSettingEnabled: boolean | null = null;
  if (tableExists(sqlite, "settings")) {
    const row = sqlite
      .prepare("SELECT value FROM settings WHERE key = 'maker_enabled' LIMIT 1")
      .get() as { value: string | number | null } | undefined;
    if (row?.value != null) {
      const raw = String(row.value).trim();
      makerSettingEnabled = raw === "1" || raw.toLowerCase() === "true";
    }
  }

  const makerDisabledBySetting = makerSettingEnabled === false;
  if (makerDisabledBySetting) {
    console.log(
      `[invariant:maker-real-fill-activity] PASS db=${dbPath} skipped=maker_disabled settings_enabled=${
        makerSettingEnabled == null ? "unknown" : String(makerSettingEnabled)
      }`
    );
    process.exit(0);
  }

  const makerOrders = (
    sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM shadow_orders
         WHERE ts >= ?
           AND execution_mode = 'SHADOW'
           AND kind IN ('MAKER_BID', 'MAKER_ASK')`
      )
      .get(sinceTs) as { c: number }
  ).c;

  const makerRealFills = (
    sqlite
      .prepare(
        `SELECT COUNT(*) as c
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE f.ts >= ?
           AND (f.method IS NULL OR f.method != 'synthetic_fill')
           AND o.execution_mode = 'SHADOW'
           AND o.kind IN ('MAKER_BID', 'MAKER_ASK')`
      )
      .get(sinceTs) as { c: number }
  ).c;

  const fillRate = makerOrders > 0 ? makerRealFills / makerOrders : 0;
  const failures: string[] = [];
  if (fillRate < minFillRate) {
    failures.push(`maker fill rate below threshold actual=${fillRate.toFixed(6)} required>=${minFillRate.toFixed(6)}`);
  }
  if (makerRealFills < minRealFills) {
    failures.push(`maker real fills below threshold actual=${makerRealFills} required>=${minRealFills}`);
  }

  if (failures.length > 0) {
    console.error(`[invariant:maker-real-fill-activity] FAIL db=${dbPath}`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `[invariant:maker-real-fill-activity] PASS db=${dbPath} window_hours=${windowHours} orders=${makerOrders} real_fills=${makerRealFills} fill_rate=${fillRate.toFixed(6)}`
  );
} finally {
  safeClose(sqlite);
}
