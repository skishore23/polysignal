import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../packages/storage/src/db";

type TempFixture = {
  root: string;
  sqlite: Database.Database;
  migrationsDir: string;
};

const fixtures: TempFixture[] = [];

const makeFixture = (sqlByFilename: Record<string, string>): TempFixture => {
  const root = mkdtempSync(path.join(os.tmpdir(), "polysignal-migration-test-"));
  const migrationsDir = path.join(root, "migrations");
  const sqlite = new Database(path.join(root, "test.db"));
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec("CREATE TABLE IF NOT EXISTS _healthcheck (id INTEGER PRIMARY KEY);");
  rmSync(migrationsDir, { recursive: true, force: true });
  mkdirSync(migrationsDir, { recursive: true });
  for (const [filename, content] of Object.entries(sqlByFilename)) {
    const filePath = path.join(migrationsDir, filename);
    writeFileSync(filePath, content, "utf-8");
  }
  const fixture = { root, sqlite, migrationsDir };
  fixtures.push(fixture);
  return fixture;
};

afterEach(() => {
  while (fixtures.length > 0) {
    const next = fixtures.pop();
    if (!next) continue;
    try {
      next.sqlite.close();
    } catch {
      // noop
    }
    rmSync(next.root, { recursive: true, force: true });
  }
});

describe("runMigrations immutability and idempotency", () => {
  it("fails when an applied migration file is modified", () => {
    const fixture = makeFixture({
      "0001_init.sql": `
        CREATE TABLE IF NOT EXISTS alpha (id INTEGER PRIMARY KEY, value TEXT);
      `
    });

    runMigrations(fixture.sqlite, fixture.migrationsDir);
    writeFileSync(
      path.join(fixture.migrationsDir, "0001_init.sql"),
      `
        CREATE TABLE IF NOT EXISTS alpha (id INTEGER PRIMARY KEY, value TEXT, extra TEXT);
      `,
      "utf-8"
    );

    expect(() => runMigrations(fixture.sqlite, fixture.migrationsDir)).toThrow(
      /Applied migration modified; create a new migration instead of editing\./
    );
  });

  it("is idempotent when re-running unchanged migrations", () => {
    const fixture = makeFixture({
      "0001_init.sql": `
        CREATE TABLE IF NOT EXISTS beta (id INTEGER PRIMARY KEY, value TEXT);
      `,
      "0002_data.sql": `
        INSERT INTO beta (value) VALUES ('a');
      `
    });

    runMigrations(fixture.sqlite, fixture.migrationsDir);
    expect(() => runMigrations(fixture.sqlite, fixture.migrationsDir)).not.toThrow();

    const migrationCount = fixture.sqlite
      .prepare("SELECT COUNT(*) as c FROM schema_migrations")
      .get() as { c: number };
    expect(migrationCount.c).toBe(2);

    const betaRows = fixture.sqlite.prepare("SELECT COUNT(*) as c FROM beta").get() as { c: number };
    expect(betaRows.c).toBe(1);
  });
});
