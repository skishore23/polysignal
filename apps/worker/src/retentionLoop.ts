/**
 * Retention Loop
 *
 * Periodically aggregates, backs up, and cleans up data to prevent disk exhaustion
 * while preserving historical metrics for backtesting and protecting trading data.
 *
 * Order of operations:
 * 1. Create backup (daily, before any deletions)
 * 2. Cleanup invalid feature rows (NULL mid/spread)
 * 3. Aggregate raw data into hourly/daily rollups (preserves info)
 * 4. Delete old raw data (reclaims space)
 * 5. Incremental vacuum (returns space to filesystem)
 */

import type Database from "better-sqlite3";
import * as path from "path";
import {
  runRetentionCleanup,
  runAggregation,
  createBackup,
  type RetentionConfig,
  type AggregationConfig,
  type BackupConfig,
  DEFAULT_AGGREGATION_CONFIG,
  DEFAULT_BACKUP_CONFIG,
} from "@polysignal/storage";
import type { Logger } from "./logger";

export type RetentionLoopDeps = {
  sqlite: Database.Database;
  logger: Logger;
  dataDir: string;
};

export type RetentionLoopConfig = {
  intervalHours: number;
  retention: RetentionConfig;
  aggregation?: AggregationConfig;
  backup?: BackupConfig;
  /** How often to run backups (in retention intervals). Default: 24 (daily if interval is 1h) */
  backupEveryNIntervals?: number;
  /** Disable backups entirely. Default: false */
  disableBackup?: boolean;
};

/**
 * Start the retention cleanup loop.
 * Returns a stop function.
 */
export const startRetentionLoop = (
  config: RetentionLoopConfig,
  deps: RetentionLoopDeps
): (() => void) => {
  const { sqlite, logger, dataDir } = deps;
  const intervalMs = config.intervalHours * 60 * 60 * 1000;
  const aggregationConfig = config.aggregation ?? DEFAULT_AGGREGATION_CONFIG;
  const backupConfig = config.backup ?? DEFAULT_BACKUP_CONFIG;
  const backupEveryN = config.backupEveryNIntervals ?? 24; // Daily if interval is 1h

  let intervalCount = 0;

  const runCleanup = (): void => {
    try {
      const startTime = Date.now();
      intervalCount++;

      // Step 1: Create backup (periodically, before any deletions)
      const shouldBackup = !config.disableBackup && intervalCount % backupEveryN === 1;
      if (shouldBackup) {
        logger.info("Creating database backup...");
        const backupResult = createBackup(sqlite, dataDir, backupConfig);
        if (backupResult.success) {
          const sizeMB = (backupResult.sizeBytes / 1024 / 1024).toFixed(1);
          logger.info(
            {
              path: backupResult.backupPath,
              sizeMB,
              durationMs: backupResult.durationMs,
            },
            "Database backup created"
          );
        } else {
          const reason = backupResult.error ?? "unknown";
          logger.error(
            { error: backupResult.error },
            `Database backup failed - CRITICAL: trading data may be at risk (${reason})`
          );
        }
      }

      // Step 2: Cleanup invalid feature rows (NULL mid/spread)
      const cleanupResult = runInvalidFeatureCleanup(sqlite, config.retention.deleteBatchSize);
      if (cleanupResult.deletedFeatures > 0 || cleanupResult.deletedLatest > 0) {
        logger.warn(
          cleanupResult,
          "Deleted invalid feature rows (NULL mid/spread)"
        );
      }

      // Step 3: Aggregate data BEFORE deleting (preserves historical metrics)
      // Avoid full-table COUNT(*) on very large features tables; use a fast estimate.
      const featureCount = estimateFeatureRowCount(sqlite);
      const aggregationForRun =
        featureCount > 1_000_000
          ? {
              ...aggregationConfig,
              lookbackHours: Math.min(aggregationConfig.lookbackHours, 24)
            }
          : aggregationConfig;

      if (featureCount > 1_000_000) {
        logger.info(
          {
            featureCount,
            lookbackHours: aggregationForRun.lookbackHours
          },
          "Features table large; limiting aggregation lookback to reduce locking time"
        );
      }

      logger.info("Starting data aggregation...");
      const aggResults = runAggregation(sqlite, aggregationForRun);

      const totalAggregated = aggResults.reduce((sum, r) => sum + r.bucketsCreated, 0);
      if (totalAggregated > 0) {
        const aggTables = aggResults
          .filter((r) => r.bucketsCreated > 0)
          .map((r) => `${r.table}: +${r.bucketsCreated}`)
          .join(", ");
        logger.info(
          { totalBuckets: totalAggregated, tables: aggTables },
          "Aggregation completed"
        );
      }

      // Step 4: Delete old raw data
      logger.info("Starting retention cleanup...");
      const results = runRetentionCleanup(sqlite, config.retention);

      const totalDeleted = results.reduce((sum, r) => sum + r.deletedRows, 0);
      const totalDurationMs = Date.now() - startTime;

      const tableResults = results
        .filter((r) => r.deletedRows > 0)
        .map((r) => `${r.table}: -${r.deletedRows}`)
        .join(", ");

      if (totalDeleted > 0) {
        logger.info(
          { totalDeleted, durationMs: totalDurationMs, tables: tableResults },
          "Retention cleanup completed"
        );

        // Step 5: Run incremental vacuum to reclaim space
        try {
          sqlite.exec("PRAGMA incremental_vacuum(1000)");
        } catch (vacuumErr) {
          logger.warn({ err: String(vacuumErr) }, "Incremental vacuum failed");
        }
        try {
          sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch (checkpointErr) {
          logger.warn({ err: String(checkpointErr) }, "WAL checkpoint failed");
        }
      } else {
        logger.debug("Retention cleanup: no old data to delete");
      }
    } catch (err) {
      logger.error({ err: String(err) }, "Retention/aggregation/backup failed");
    }
  };

  // Defer initial cleanup to avoid startup stalls from heavy aggregation/retention work.
  const initialDelayMs = 10 * 60 * 1000;
  const initialCleanupTimeout = setTimeout(runCleanup, initialDelayMs);

  // Then run periodically
  const intervalId = setInterval(runCleanup, intervalMs);

  logger.info(
    {
      intervalHours: config.intervalHours,
      backupEveryNIntervals: backupEveryN,
      backupRetainCount: backupConfig.retainCount,
      initialDelayMs,
    },
    "Retention loop started (first run deferred to avoid startup blocking)"
  );

  return () => {
    clearTimeout(initialCleanupTimeout);
    clearInterval(intervalId);
    logger.info("Retention loop stopped");
  };
};

function runInvalidFeatureCleanup(
  sqlite: Database.Database,
  deleteBatchSize: number
): { deletedFeatures: number; deletedLatest: number } {
  const batch = Math.max(1000, deleteBatchSize || 10000);
  const deleteFeaturesStmt = sqlite.prepare(
    `DELETE FROM features
     WHERE id IN (
       SELECT id FROM features
       WHERE mid IS NULL OR spread IS NULL
       LIMIT ?
     )`
  );
  const deleteLatestStmt = sqlite.prepare(
    `DELETE FROM latest_features WHERE mid IS NULL OR spread IS NULL`
  );

  const featuresResult = deleteFeaturesStmt.run(batch);
  const latestResult = deleteLatestStmt.run();

  return {
    deletedFeatures: featuresResult.changes,
    deletedLatest: latestResult.changes
  };
}

function estimateFeatureRowCount(sqlite: Database.Database): number {
  try {
    const row = sqlite
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'features'")
      .get() as { seq?: number } | undefined;
    const seq = Number(row?.seq ?? 0);
    if (Number.isFinite(seq) && seq > 0) return Math.floor(seq);
  } catch {
    // Fall through to MAX(id) estimate.
  }

  try {
    const row = sqlite.prepare("SELECT MAX(id) as maxId FROM features").get() as { maxId?: number | null } | undefined;
    const maxId = Number(row?.maxId ?? 0);
    return Number.isFinite(maxId) && maxId > 0 ? Math.floor(maxId) : 0;
  } catch {
    return 0;
  }
}
