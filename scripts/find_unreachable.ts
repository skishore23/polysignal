#!/usr/bin/env tsx

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const reportDir = path.join(repoRoot, "reports", "refactor-baseline");
const currentPath = path.join(reportDir, "unreachable_ts_files.txt");
const allowlistPath = path.join(reportDir, "unreachable_allowlist.txt");

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const updateAllowlist = args.has("--update-allowlist");

const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/analyze_import_graph.ts"], {
  cwd: repoRoot,
  encoding: "utf8"
});

if (run.status !== 0) {
  process.stderr.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  process.exit(run.status ?? 1);
}

const readLines = (filePath: string): string[] => {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
};

const current = new Set(readLines(currentPath));
if (updateAllowlist) {
  writeFileSync(
    allowlistPath,
    `${Array.from(current).sort().join("\n")}${current.size ? "\n" : ""}`,
    "utf8"
  );
  console.log(`[find_unreachable] updated allowlist: ${allowlistPath}`);
  process.exit(0);
}

const allowlist = new Set(readLines(allowlistPath));
const newlyUnreachable = Array.from(current).filter((file) => !allowlist.has(file)).sort();

if (!existsSync(allowlistPath) && current.size === 0) {
  console.log("[find_unreachable] no unreachable files; no allowlist required.");
  process.exit(0);
}

if (!existsSync(allowlistPath)) {
  console.log(`[find_unreachable] allowlist not found: ${allowlistPath}`);
  console.log("[find_unreachable] run with --update-allowlist to initialize.");
  if (strict) process.exit(1);
  process.exit(0);
}

if (newlyUnreachable.length === 0) {
  console.log("[find_unreachable] no new unreachable files.");
  process.exit(0);
}

console.log("[find_unreachable] new unreachable files detected:");
for (const file of newlyUnreachable) {
  console.log(` - ${file}`);
}

if (strict) {
  console.error("[find_unreachable] strict mode enabled: failing.");
  process.exit(1);
}

console.log("[find_unreachable] reporting-only mode. Use --strict to fail.");
