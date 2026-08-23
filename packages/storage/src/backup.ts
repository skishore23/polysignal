/**
 * Database Backup Module
 *
 * Creates point-in-time backups of the SQLite database.
 * Backups are stored locally and can be synced to remote storage.
 *
 * CRITICAL: This protects against:
 * - Accidental data deletion
 * - Database corruption
 * - Disk failures
 * - Application bugs
 */

import type Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export type BackupConfig = {
  /** Directory to store backups (relative to data dir or absolute) */
  readonly backupDir: string;
  /** Number of backups to retain */
  readonly retainCount: number;
  /** Prefix for backup files */
  readonly prefix: string;
};

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  backupDir: "./backups",
  retainCount: 7, // Keep 7 daily backups
  prefix: "polysignal-backup",
};

export type BackupResult = {
  readonly success: boolean;
  readonly backupPath: string | null;
  readonly sizeBytes: number;
  readonly durationMs: number;
  readonly error?: string;
};

/**
 * Format timestamp for backup filename.
 */
const formatTimestamp = (date: Date): string => {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
};

/**
 * Ensure backup directory exists.
 */
const ensureBackupDir = (dir: string): void => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

/**
 * Get list of existing backups sorted by date (oldest first).
 */
const getExistingBackups = (dir: string, prefix: string): string[] => {
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".db"))
    .sort();
};

/**
 * Remove old backups beyond retention count.
 */
const pruneOldBackups = (
  dir: string,
  prefix: string,
  retainCount: number
): number => {
  const backups = getExistingBackups(dir, prefix);
  const toDelete = backups.slice(0, Math.max(0, backups.length - retainCount));

  for (const backup of toDelete) {
    fs.unlinkSync(path.join(dir, backup));
  }

  return toDelete.length;
};

/**
 * Create a backup of the database using SQLite's backup API.
 * This creates a consistent point-in-time snapshot even while the DB is in use.
 */
export const createBackup = (
  db: Database.Database,
  dataDir: string,
  config: BackupConfig = DEFAULT_BACKUP_CONFIG
): BackupResult => {
  const startTime = Date.now();

  try {
    // Resolve backup directory
    const backupDir = path.isAbsolute(config.backupDir)
      ? config.backupDir
      : path.join(dataDir, config.backupDir);

    ensureBackupDir(backupDir);

    // Generate backup filename with timestamp
    const timestamp = formatTimestamp(new Date());
    const backupFilename = `${config.prefix}-${timestamp}.db`;
    const backupPath = path.join(backupDir, backupFilename);

    // Use SQLite's backup API for consistent snapshot
    db.backup(backupPath);

    // Get backup size
    const stats = fs.statSync(backupPath);

    // Prune old backups
    pruneOldBackups(backupDir, config.prefix, config.retainCount);

    return {
      success: true,
      backupPath,
      sizeBytes: stats.size,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      backupPath: null,
      sizeBytes: 0,
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

/**
 * List available backups.
 */
export const listBackups = (
  dataDir: string,
  config: BackupConfig = DEFAULT_BACKUP_CONFIG
): readonly { name: string; sizeBytes: number; createdAt: Date }[] => {
  const backupDir = path.isAbsolute(config.backupDir)
    ? config.backupDir
    : path.join(dataDir, config.backupDir);

  const backups = getExistingBackups(backupDir, config.prefix);

  return backups.map((name) => {
    const filePath = path.join(backupDir, name);
    const stats = fs.statSync(filePath);
    return {
      name,
      sizeBytes: stats.size,
      createdAt: stats.mtime,
    };
  });
};

/**
 * Verify backup integrity by opening it and running a simple query.
 */
export const verifyBackup = (
  backupPath: string,
  Database: typeof import("better-sqlite3")
): { valid: boolean; error?: string } => {
  try {
    const db = new Database(backupPath, { readonly: true });
    try {
      // Run integrity check
      const result = db.pragma("integrity_check") as { integrity_check: string }[];
      const isOk = result[0]?.integrity_check === "ok";

      // Also verify critical tables exist
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('wallets', 'markets', 'tokens')"
        )
        .all() as { name: string }[];

      const hasCriticalTables = tables.length === 3;

      return {
        valid: isOk && hasCriticalTables,
        error: !isOk
          ? "Integrity check failed"
          : !hasCriticalTables
          ? "Missing critical tables"
          : undefined,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
