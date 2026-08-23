#!/usr/bin/env npx tsx
import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");

const args = new Set(process.argv.slice(2));
if (!args.has("--confirm")) {
  console.error("Refusing destructive reset without --confirm");
  process.exit(1);
}

const dbPath = path.join(repoRoot, "data", "dev.db");
const baselineDir = path.join(repoRoot, "docs", "refactor_baseline");
const appendOnlySnapshotPath = path.join(
  repoRoot,
  "data",
  "invariants",
  "decision-log-append-only.snapshot.json"
);
mkdirSync(baselineDir, { recursive: true });

try {
  execSync("npx tsx scripts/extract-baseline-metrics.ts", {
    cwd: repoRoot,
    stdio: "inherit"
  });
} catch (err) {
  console.warn("[cutover-reset] Baseline metrics export failed, continuing", err instanceof Error ? err.message : String(err));
}

for (const suffix of ["", "-wal", "-shm"]) {
  const target = `${dbPath}${suffix}`;
  if (existsSync(target)) {
    rmSync(target, { force: true });
    console.log(`[cutover-reset] Removed ${target}`);
  }
}

if (existsSync(appendOnlySnapshotPath)) {
  rmSync(appendOnlySnapshotPath, { force: true });
  console.log(`[cutover-reset] Removed stale invariant snapshot ${appendOnlySnapshotPath}`);
}

execSync("npm run migrate", {
  cwd: repoRoot,
  stdio: "inherit"
});

const summaryPath = path.join(baselineDir, "hard_cutover_reset.json");
writeFileSync(
  summaryPath,
  JSON.stringify(
    {
      ts: Date.now(),
      snapshotPath: path.relative(repoRoot, appendOnlySnapshotPath),
      dbPath: path.relative(repoRoot, dbPath),
      status: "completed"
    },
    null,
    2
  )
);

console.log(`[cutover-reset] Summary written: ${summaryPath}`);
