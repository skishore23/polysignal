import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type DbClient = {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
};

const normalizeAutoVacuumResult = (result: unknown): number | null => {
  if (typeof result === "number") {
    return result;
  }
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0];
    if (typeof first === "number") return first;
    if (typeof first === "object" && first !== null && "auto_vacuum" in first) {
      const value = (first as { auto_vacuum?: unknown }).auto_vacuum;
      return typeof value === "number" ? value : null;
    }
  }
  return null;
};

export function openDatabase(dbPath: string): DbClient {
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 30000");
  const autoVacResult = sqlite.pragma("auto_vacuum");
  const autoVacValue = normalizeAutoVacuumResult(autoVacResult);
  if (autoVacValue !== 2) {
    sqlite.pragma("auto_vacuum = INCREMENTAL");
    console.info("[db] auto_vacuum=INCREMENTAL (run `npm run db:auto-vacuum` once to finish conversion)");
  }
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

const parseSqlStatements = (sqlContent: string) =>
  sqlContent
    .replace(/--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const applySqlFile = (sqlite: Database.Database, filePath: string): void => {
  if (!existsSync(filePath)) return;
  const sqlContent = readFileSync(filePath, "utf-8");
  if (!sqlContent.trim()) return;
  const statements = parseSqlStatements(sqlContent);

  for (const statement of statements) {
    sqlite.exec(statement + ";");
  }
};

type MigrationFile = {
  filename: string;
  fullPath: string;
  checksum: string;
};

const ensureSchemaMigrationsTable = (sqlite: Database.Database): void => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum_sha256 TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
  `);
};

const readMigrationFiles = (migrationsPath: string): MigrationFile[] => {
  const files = readdirSync(migrationsPath)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  return files.map((filename) => {
    const fullPath = path.join(migrationsPath, filename);
    const content = readFileSync(fullPath, "utf-8");
    const checksum = createHash("sha256").update(content).digest("hex");
    return { filename, fullPath, checksum };
  });
};

const readAppliedMigrations = (sqlite: Database.Database): Map<string, string> => {
  const rows = sqlite
    .prepare("SELECT filename, checksum_sha256 as checksum FROM schema_migrations ORDER BY filename ASC")
    .all() as Array<{ filename: string; checksum: string }>;
  return new Map(rows.map((row) => [row.filename, row.checksum]));
};

const markMigrationApplied = (
  sqlite: Database.Database,
  file: MigrationFile,
  appliedAtMs: number
): void => {
  sqlite
    .prepare(
      `INSERT INTO schema_migrations (filename, checksum_sha256, applied_at_ms)
       VALUES (?, ?, ?)`
    )
    .run(file.filename, file.checksum, appliedAtMs);
};

export function runMigrations(sqlite: Database.Database, migrationsPath: string): void {
  ensureSchemaMigrationsTable(sqlite);
  const files = readMigrationFiles(migrationsPath);
  const applied = readAppliedMigrations(sqlite);

  for (const file of files) {
    const existingChecksum = applied.get(file.filename);
    if (existingChecksum != null) {
      if (existingChecksum !== file.checksum) {
        throw new Error(
          `Applied migration modified; create a new migration instead of editing. File: ${file.filename}`
        );
      }
      continue;
    }

    applySqlFile(sqlite, file.fullPath);
    markMigrationApplied(sqlite, file, Date.now());
    applied.set(file.filename, file.checksum);
  }
}
