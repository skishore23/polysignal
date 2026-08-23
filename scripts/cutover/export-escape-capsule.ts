#!/usr/bin/env npx tsx
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

type CliOptions = {
  confirm: boolean;
  dbPath: string | null;
};

const parseArgs = (): CliOptions => {
  const args = process.argv.slice(2);
  let confirm = false;
  let dbPath: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i];
    if (raw === "--confirm") {
      confirm = true;
      continue;
    }
    if (raw === "--db" && args[i + 1]) {
      dbPath = args[i + 1]!;
      i += 1;
    }
  }
  return { confirm, dbPath };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const toAbsolute = (candidate: string): string =>
  path.isAbsolute(candidate) ? candidate : path.join(repoRoot, candidate);

const nowStamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

const sha256 = (input: string | Buffer): string =>
  createHash("sha256").update(input).digest("hex");

const options = parseArgs();
if (!options.confirm) {
  console.error("Refusing capsule export without --confirm");
  process.exit(1);
}

const dbPath = toAbsolute(options.dbPath ?? "data/dev.db");
if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const stamp = nowStamp();
const outDir = path.join(repoRoot, "data", "cutover-capsule", stamp);
await mkdir(outDir, { recursive: true });

const sqlite = new Database(dbPath, { readonly: true });
try {
  const tableRows = sqlite
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name ASC`
    )
    .all() as Array<{ name: string }>;

  const rowCounts: Record<string, number> = {};
  for (const row of tableRows) {
    const countRow = sqlite.prepare(`SELECT COUNT(*) as c FROM ${row.name}`).get() as { c?: number } | undefined;
    rowCounts[row.name] = Number(countRow?.c ?? 0);
  }

  const schemaRows = sqlite
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE sql IS NOT NULL
       ORDER BY type ASC, name ASC`
    )
    .all() as Array<{ name: string; sql: string }>;
  const schemaSql = schemaRows.map((r) => r.sql).join("\n;\n");
  const schemaHash = sha256(schemaSql);

  const dumpAttempt = spawnSync("sqlite3", [dbPath, ".dump"], {
    cwd: repoRoot,
    encoding: "utf-8"
  });

  let dumpKind: "sql_dump" | "db_binary_fallback" = "sql_dump";
  let dumpFile: string;
  let dumpSha256: string;
  if (dumpAttempt.status === 0 && typeof dumpAttempt.stdout === "string" && dumpAttempt.stdout.length > 0) {
    const dumpSqlPath = path.join(outDir, "dump.sql");
    await writeFile(dumpSqlPath, dumpAttempt.stdout, "utf-8");
    const dumpGzipPath = path.join(outDir, "dump.sql.gz");
    const compressed = gzipSync(Buffer.from(dumpAttempt.stdout, "utf-8"));
    await writeFile(dumpGzipPath, compressed);
    dumpFile = path.relative(repoRoot, dumpGzipPath);
    dumpSha256 = sha256(compressed);
  } else {
    dumpKind = "db_binary_fallback";
    const raw = await readFile(dbPath);
    const compressed = gzipSync(raw);
    const fallbackPath = path.join(outDir, "dev.db.gz");
    await writeFile(fallbackPath, compressed);
    dumpFile = path.relative(repoRoot, fallbackPath);
    dumpSha256 = sha256(compressed);
  }

  const dbStats = await stat(dbPath);
  const metadata = {
    createdAtIso: new Date().toISOString(),
    dbPath: path.relative(repoRoot, dbPath),
    dbSizeBytes: dbStats.size,
    schemaHashSha256: schemaHash,
    dumpKind,
    dumpFile,
    dumpSha256,
    tableCount: tableRows.length,
    rowCounts
  };

  const metadataPath = path.join(outDir, "metadata.json");
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

  console.log(`[escape-capsule] Created: ${path.relative(repoRoot, outDir)}`);
  console.log(`[escape-capsule] Metadata: ${path.relative(repoRoot, metadataPath)}`);
} finally {
  sqlite.close();
}
