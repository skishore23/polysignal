#!/usr/bin/env npx tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../packages/storage/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dbPath = process.env.DB_PATH
  ? path.isAbsolute(process.env.DB_PATH)
    ? process.env.DB_PATH
    : path.join(repoRoot, process.env.DB_PATH)
  : path.join(repoRoot, "data", "dev.db");

console.log(`[db:auto-vacuum] Database: ${dbPath}`);
const { sqlite } = openDatabase(dbPath);
const current = sqlite.pragma("auto_vacuum");
const currentValue = Array.isArray(current) && current.length > 0
  ? typeof current[0] === "number"
    ? current[0]
    : typeof current[0] === "object"
      ? current[0]?.auto_vacuum ?? null
      : null
  : typeof current === "number"
    ? current
    : null;

if (currentValue === 2) {
  console.log("[db:auto-vacuum] Already running with INCREMENTAL auto vacuum; nothing to do");
} else {
  console.log("[db:auto-vacuum] Running VACUUM to complete conversion...");
  sqlite.exec("VACUUM");
  console.log("[db:auto-vacuum] VACUUM complete");
}

sqlite.close();
