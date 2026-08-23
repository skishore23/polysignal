#!/usr/bin/env npx tsx
/**
 * Run database migrations before starting the app.
 * Usage: npx tsx scripts/migrate.ts
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, runMigrations } from "../packages/storage/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const migrationsPath = path.join(repoRoot, "packages", "storage", "migrations");

const dbPath = process.env.DB_PATH
  ? path.isAbsolute(process.env.DB_PATH)
    ? process.env.DB_PATH
    : path.join(repoRoot, process.env.DB_PATH)
  : path.join(repoRoot, "data", "dev.db");

console.log(`[migrate] Database: ${dbPath}`);
console.log(`[migrate] Migrations: ${migrationsPath}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isSqliteBusy = (err: unknown): boolean => {
  if (!err) return false;
  if (typeof err === "object" && err !== null && "code" in err) {
    return (err as { code?: string }).code === "SQLITE_BUSY";
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes("database is locked");
};

const runWithRetry = async (attempts: number): Promise<void> => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const start = Date.now();
    const { sqlite } = openDatabase(dbPath);
    try {
      runMigrations(sqlite, migrationsPath);
      sqlite.close();
      console.log(`[migrate] Completed in ${Date.now() - start}ms`);
      return;
    } catch (err) {
      sqlite.close();
      if (!isSqliteBusy(err) || attempt === attempts) {
        throw err;
      }
      const delay = Math.min(2000, 250 * attempt);
      console.warn(`[migrate] Database busy; retrying in ${delay}ms (attempt ${attempt}/${attempts})`);
      await sleep(delay);
    }
  }
};

await runWithRetry(8);
