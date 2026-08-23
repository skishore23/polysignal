// Temporary database harness for tests
// Creates temporary SQLite DBs with migrations for isolated test runs

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDatabase, runMigrations } from "@polysignal/storage";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const migrationsPath = path.join(repoRoot, "packages", "storage", "migrations");

export type TempDb = {
  path: string;
  sqlite: Database.Database;
  cleanup: () => Promise<void>;
};

/**
 * Create temporary SQLite DB with migrations.
 * Returns DB client and cleanup function.
 */
export async function createTempDb(): Promise<TempDb> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "polysignal-test-"));
  const dbPath = path.join(tempDir, "test.db");

  const { sqlite } = openDatabase(dbPath);
  runMigrations(sqlite, migrationsPath);

  return {
    path: dbPath,
    sqlite,
    cleanup: async () => {
      sqlite.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

/**
 * Destroy temporary DB (cleanup).
 */
export async function destroyTempDb(db: TempDb): Promise<void> {
  await db.cleanup();
}

/**
 * Create multiple temp DBs for comparison tests.
 */
export async function createTempDbs(count: number): Promise<TempDb[]> {
  const dbs: TempDb[] = [];
  for (let i = 0; i < count; i++) {
    dbs.push(await createTempDb());
  }
  return dbs;
}

/**
 * Cleanup multiple temp DBs.
 */
export async function destroyTempDbs(dbs: TempDb[]): Promise<void> {
  await Promise.all(dbs.map((db) => destroyTempDb(db)));
}
