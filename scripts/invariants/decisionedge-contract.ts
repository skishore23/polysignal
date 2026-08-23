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
const windowMin = Math.max(1, numberArg(args, "window-min", 60));
const sinceTs = Date.now() - windowMin * 60_000;

const sqlite = openReadOnlyDatabase(dbPath);

try {
  const requiredTables = ["decision_log", "shadow_orders", "shadow_fills", "shadow_markouts"];
  const missingTables = requiredTables.filter((name) => !tableExists(sqlite, name));
  if (missingTables.length > 0) {
    console.error(`[invariant:decisionedge-contract] FAIL db=${dbPath}`);
    console.error(`  - missing tables: ${missingTables.join(", ")}`);
    process.exit(1);
  }

  const summary = sqlite
    .prepare(
      `WITH order_agg AS (
         SELECT decision_group_id as decisionGroupId,
                COUNT(*) as ordersCount
         FROM shadow_orders
         WHERE decision_group_id IS NOT NULL
         GROUP BY decision_group_id
       ),
       fill_agg AS (
         SELECT o.decision_group_id as decisionGroupId,
                COUNT(DISTINCT f.id) as fillsCount,
                COALESCE(SUM(CASE WHEN f.price IS NOT NULL AND f.size IS NOT NULL THEN f.price * f.size ELSE 0 END), 0) as fillNotional
         FROM shadow_orders o
         LEFT JOIN shadow_fills f
           ON f.order_id = o.id
          AND (f.method IS NULL OR f.method != 'synthetic_fill')
         WHERE o.decision_group_id IS NOT NULL
         GROUP BY o.decision_group_id
       ),
       markout_agg AS (
         SELECT o.decision_group_id as decisionGroupId,
                AVG(CASE WHEN m.horizon_ms = 60000 THEN m.markout_bps END) as markout1mBpsAvg,
                AVG(CASE WHEN m.horizon_ms = 300000 THEN m.markout_bps END) as markout5mBpsAvg
         FROM shadow_orders o
         JOIN shadow_fills f
           ON f.order_id = o.id
          AND (f.method IS NULL OR f.method != 'synthetic_fill')
         JOIN shadow_markouts m ON m.fill_id = f.id
         WHERE o.decision_group_id IS NOT NULL
         GROUP BY o.decision_group_id
       ),
       decision_edge AS (
         SELECT
           d.id as decisionId,
           d.ts as ts,
           d.token_id as tokenId,
           d.kind as kind,
           d.decision as decision,
           COALESCE(oa.ordersCount, 0) as ordersCount,
           COALESCE(fa.fillsCount, 0) as fillsCount,
           COALESCE(fa.fillNotional, 0) as fillNotional,
           ma.markout1mBpsAvg as markout1mBpsAvg,
           ma.markout5mBpsAvg as markout5mBpsAvg
         FROM decision_log d
         LEFT JOIN order_agg oa ON oa.decisionGroupId = d.decision_group_id
         LEFT JOIN fill_agg fa ON fa.decisionGroupId = d.decision_group_id
         LEFT JOIN markout_agg ma ON ma.decisionGroupId = d.decision_group_id
         WHERE d.ts >= ?
       )
       SELECT
         COUNT(*) as rowsCount,
         COUNT(DISTINCT decisionId) as distinctDecisionIds,
         SUM(CASE WHEN decisionId IS NULL OR ts IS NULL OR tokenId IS NULL OR kind IS NULL OR decision IS NULL THEN 1 ELSE 0 END) as nullCritical
       FROM decision_edge`
    )
    .get(sinceTs) as {
    rowsCount: number;
    distinctDecisionIds: number;
    nullCritical: number;
  };

  const failures: string[] = [];
  if ((summary.rowsCount ?? 0) <= 0) {
    failures.push(`no decision-edge rows in last ${windowMin}m`);
  }
  if ((summary.rowsCount ?? 0) !== (summary.distinctDecisionIds ?? 0)) {
    failures.push(
      `cardinality mismatch rows=${summary.rowsCount ?? 0} distinctDecisionIds=${summary.distinctDecisionIds ?? 0}`
    );
  }
  if ((summary.nullCritical ?? 0) > 0) {
    failures.push(`null critical fields rows=${summary.nullCritical}`);
  }

  if (failures.length > 0) {
    console.error(`[invariant:decisionedge-contract] FAIL db=${dbPath}`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `[invariant:decisionedge-contract] PASS db=${dbPath} window_min=${windowMin} rows=${summary.rowsCount}`
  );
} finally {
  safeClose(sqlite);
}
