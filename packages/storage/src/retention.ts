/**
 * Data Retention Module
 *
 * Implements tiered data retention for high-frequency trading data:
 * - Hot tier (0-48h): Full resolution for backtesting
 * - Purge tier (>48h): Delete to reclaim space
 *
 * CRITICAL: The following tables are NEVER deleted (protected):
 * - wallets: Wallet configuration and balances
 * - markets: Market metadata
 * - tokens: Token metadata
 * - settings: Application settings
 * - latest_features: Current feature state per token
 * - All aggregate tables (hourly_*, daily_*): Historical rollups
 *
 * This module is designed to run periodically without blocking the main loop.
 */

import type Database from "better-sqlite3";

/**
 * Tables that must NEVER be deleted - critical trading data.
 * This is a safety check - if any retention logic tries to touch these, it fails.
 */
export const PROTECTED_TABLES = [
  // Core trading data - NEVER delete
  "wallets",
  "markets",
  "tokens",
  "settings",
  // Latest state tables - single row per entity, not time series
  "latest_features",
  // Aggregate tables (historical rollups - keep forever for backtesting)
  "hourly_candles",
  "daily_candles",
] as const;

/**
 * Tables that have time-series data and ARE cleaned up by retention.
 * These tables grow continuously and must be pruned to prevent disk exhaustion.
 * IMPORTANT: Data is AGGREGATED before deletion to preserve historical metrics.
 */
export const RETENTION_TABLES = [
  "features",        // Per-second market features -> hourly_candles
  "clob_events",     // Raw order book events (not aggregated, very short retention)
  "alerts",          // System alerts
  "decision_log",    // SKIP events for Liquidity Gate UI
  "external_priors", // External prior snapshots used by belief layer
  "arb_opportunities", // Structural arbitrage detections
  "arb_executions",  // Arbitrage execution outcomes
  "shadow_orders",   // Shadow execution intents (maker/taker)
  "shadow_fills",    // Shadow fills (derived from trades/quotes)
  "shadow_markouts", // Shadow markouts (fill quality)
] as const;

export type RetentionConfig = {
  /** Features retention in hours (default: 48) */
  featuresRetentionHours: number;
  /** Maker quotes retention in hours (default: 24) */
  makerQuotesRetentionHours: number;
  /** Shadow data retention in hours (default: 24) */
  makerDataRetentionHours: number;
  /** Alerts retention in hours (default: 24) */
  alertsRetentionHours: number;
  /** CLOB events retention in hours (default: 4) */
  clobEventsRetentionHours: number;
  /** Batch size for deletes to avoid long locks */
  deleteBatchSize: number;
};

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  featuresRetentionHours: 24,
  makerQuotesRetentionHours: 24,
  makerDataRetentionHours: 24,
  alertsRetentionHours: 24,
  clobEventsRetentionHours: 1,
  deleteBatchSize: 10000,
};

type TableConfig = {
  name: string;
  tsColumn: string;
  retentionHoursKey: keyof RetentionConfig;
};

/**
 * Order matters: delete children before parents to respect FK constraints.
 * - shadow_markouts.fill_id → shadow_fills.id
 * - shadow_fills.order_id → shadow_orders.id
 */
const TABLES: readonly TableConfig[] = [
  { name: "features", tsColumn: "ts", retentionHoursKey: "featuresRetentionHours" },
  { name: "shadow_markouts", tsColumn: "ts", retentionHoursKey: "makerDataRetentionHours" },
  { name: "shadow_fills", tsColumn: "ts", retentionHoursKey: "makerDataRetentionHours" },
  { name: "shadow_orders", tsColumn: "ts", retentionHoursKey: "makerDataRetentionHours" },
  { name: "decision_log", tsColumn: "ts", retentionHoursKey: "makerDataRetentionHours" },
  { name: "external_priors", tsColumn: "ts", retentionHoursKey: "makerDataRetentionHours" },
  { name: "arb_opportunities", tsColumn: "ts", retentionHoursKey: "makerDataRetentionHours" },
  { name: "arb_executions", tsColumn: "ts", retentionHoursKey: "makerDataRetentionHours" },
  { name: "alerts", tsColumn: "ts", retentionHoursKey: "alertsRetentionHours" },
  { name: "clob_events", tsColumn: "recv_ts_ms", retentionHoursKey: "clobEventsRetentionHours" },
] as const;

const tableExists = (db: Database.Database, name: string): boolean => {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return row !== undefined;
};

export function reconcileShadowOrderDecisionRefs(db: Database.Database): number {
  if (!tableExists(db, "shadow_orders")) return 0;
  const result = db
    .prepare(
      `UPDATE shadow_orders
       SET decision_group_id = NULL
       WHERE decision_group_id IS NOT NULL
         AND TRIM(decision_group_id) = ''`
    )
    .run();
  return result.changes;
}

/**
 * Safety check - throws if trying to delete from protected tables.
 */
const assertNotProtected = (tableName: string): void => {
  if ((PROTECTED_TABLES as readonly string[]).includes(tableName)) {
    throw new Error(
      `CRITICAL: Attempted to delete from protected table '${tableName}'. ` +
      `This table contains critical trading data that must never be deleted.`
    );
  }
};

type CleanupResult = {
  table: string;
  deletedRows: number;
  remainingRows: number;
  durationMs: number;
};

/**
 * Delete old rows from a table in batches to avoid long locks.
 * Returns number of rows deleted.
 *
 * SAFETY: Throws if tableName is in PROTECTED_TABLES.
 */
const deleteOldRowsBatched = (
  db: Database.Database,
  tableName: string,
  tsColumn: string,
  cutoffMs: number,
  batchSize: number
): number => {
  // CRITICAL: Safety check to prevent accidental deletion of trading data
  assertNotProtected(tableName);

  let totalDeleted = 0;

  // Use a loop with LIMIT to delete in batches
  const deleteStmt = db.prepare(
    `DELETE FROM ${tableName} WHERE rowid IN (
      SELECT rowid FROM ${tableName} WHERE ${tsColumn} < ? LIMIT ?
    )`
  );

  let deleted: number;
  do {
    const result = deleteStmt.run(cutoffMs, batchSize);
    deleted = result.changes;
    totalDeleted += deleted;
  } while (deleted === batchSize);

  return totalDeleted;
};

/**
 * Run retention cleanup for all tables.
 * This is designed to be called periodically (e.g., every hour).
 */
export const runRetentionCleanup = (
  db: Database.Database,
  config: RetentionConfig = DEFAULT_RETENTION_CONFIG
): readonly CleanupResult[] => {
  const now = Date.now();
  const results: CleanupResult[] = [];

  for (const table of TABLES) {
    if (!tableExists(db, table.name)) {
      continue;
    }

    const retentionHours = config[table.retentionHoursKey];
    if (typeof retentionHours !== "number") continue;
    
    const cutoffMs = now - retentionHours * 60 * 60 * 1000;
    const startTime = Date.now();

    const countBefore = (
      db.prepare(`SELECT COUNT(*) as c FROM ${table.name}`).get() as { c: number }
    ).c;

    const deleted = deleteOldRowsBatched(
      db,
      table.name,
      table.tsColumn,
      cutoffMs,
      config.deleteBatchSize
    );

    const countAfter = (
      db.prepare(`SELECT COUNT(*) as c FROM ${table.name}`).get() as { c: number }
    ).c;

    results.push({
      table: table.name,
      deletedRows: deleted,
      remainingRows: countAfter,
      durationMs: Date.now() - startTime,
    });
  }

  return results;
};

/**
 * Get current table sizes for monitoring.
 */
export const getTableSizes = (
  db: Database.Database
): ReadonlyMap<string, number> => {
  const sizes = new Map<string, number>();
  
  for (const table of TABLES) {
    if (!tableExists(db, table.name)) continue;
    
    const row = db.prepare(`SELECT COUNT(*) as c FROM ${table.name}`).get() as { c: number };
    sizes.set(table.name, row.c);
  }
  
  return sizes;
};

/**
 * Estimate database size and growth rate.
 */
export const estimateStorageMetrics = (
  db: Database.Database
): {
  totalRows: number;
  estimatedDailyGrowth: number;
  tablesOverThreshold: readonly string[];
} => {
  const ROW_THRESHOLDS: Record<string, number> = {
    features: 5_000_000,      // ~1.5 days at full rate
    alerts: 100_000,
    clob_events: 500_000,
  };

  const sizes = getTableSizes(db);
  let totalRows = 0;
  const overThreshold: string[] = [];

  for (const [table, count] of sizes) {
    totalRows += count;
    const threshold = ROW_THRESHOLDS[table];
    if (threshold && count > threshold) {
      overThreshold.push(table);
    }
  }

  // Estimate daily growth based on known rates
  // features: 400 tokens × 86400 sec = 34.5M/day
  // shadow_orders/fills can also be high frequency
  const estimatedDailyGrowth = 400 * 86400 + 400 * 86400; // ~69M rows/day worst case

  return {
    totalRows,
    estimatedDailyGrowth,
    tablesOverThreshold: overThreshold,
  };
};
