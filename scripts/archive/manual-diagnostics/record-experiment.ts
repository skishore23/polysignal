/**
 * Append one experiment run to the ledger. Builds run_context (git hash, config fingerprint, db snapshot).
 * Usage:
 *   npx tsx scripts/archive/manual-diagnostics/record-experiment.ts --hypothesis "..." --verdict works|doesnt|inconclusive|killed [--scope ...] [--confidence ...] [--next-action ...] [--params '{}'] [--results '{}'] [--db data/dev.db]
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { openDatabase, experimentRuns } from "../../../packages/storage/src/index.js";

type Verdict = "works" | "doesnt" | "inconclusive" | "killed";

function parseArgs(): {
  db: string;
  hypothesis: string;
  verdict: Verdict;
  scope: string | null;
  confidence: string | null;
  nextAction: string | null;
  paramsJson: string | null;
  resultsJson: string | null;
  notes: string | null;
} {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const i = argv.indexOf(k);
    if (i === -1) return def;
    return argv[i + 1];
  };
  const db = get("--db", "data/dev.db") ?? "data/dev.db";
  const hypothesis = get("--hypothesis");
  const verdictRaw = get("--verdict");
  if (!hypothesis || !verdictRaw) {
    throw new Error("Required: --hypothesis and --verdict (works|doesnt|inconclusive|killed)");
  }
  const verdict = verdictRaw as Verdict;
  if (!["works", "doesnt", "inconclusive", "killed"].includes(verdict)) {
    throw new Error("--verdict must be one of: works, doesnt, inconclusive, killed");
  }
  return {
    db: path.isAbsolute(db) ? db : path.resolve(process.cwd(), db),
    hypothesis,
    verdict,
    scope: get("--scope") ?? null,
    confidence: get("--confidence") ?? null,
    nextAction: get("--next-action") ?? null,
    paramsJson: get("--params") ?? null,
    resultsJson: get("--results") ?? null,
    notes: get("--notes") ?? null
  };
}

function gitShortHash(): string | null {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" });
  if (r.status !== 0 || !r.stdout?.trim()) return null;
  return r.stdout.trim();
}

function configFingerprint(): string | null {
  const workerPath = path.resolve(process.cwd(), "configs", "worker.json");
  if (!existsSync(workerPath)) return null;
  try {
    const worker = readFileSync(workerPath, "utf-8");
    return createHash("sha256").update(worker).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

function dbSnapshot(sqlite: ReturnType<typeof openDatabase>["sqlite"]): number | null {
  const row = sqlite.prepare("SELECT MAX(ts) as ts FROM shadow_fills").get() as { ts: number | null };
  return row?.ts ?? null;
}

function runContext(
  sqlite: ReturnType<typeof openDatabase>["sqlite"],
  codeVersion: string | null
): string {
  const payload = {
    code_version: codeVersion ?? null,
    config_fingerprint: configFingerprint(),
    db_snapshot: dbSnapshot(sqlite)
  };
  return JSON.stringify(payload);
}

function main(): void {
  const args = parseArgs();
  const { sqlite, db } = openDatabase(args.db);
  const ts = Date.now();
  const gitHash = gitShortHash();
  const runContextJson = runContext(sqlite, gitHash);

  db.insert(experimentRuns).values({
    ts,
    gitHash,
    hypothesis: args.hypothesis,
    scope: args.scope,
    confidence: args.confidence,
    paramsJson: args.paramsJson,
    resultsJson: args.resultsJson,
    verdict: args.verdict,
    nextAction: args.nextAction,
    notes: args.notes,
    runContextJson
  }).run();

  const runId = `${new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z")}_${(gitHash ?? "n/a").slice(0, 7)}`;
  console.log("Recorded:", runId, args.verdict, args.hypothesis.slice(0, 50) + (args.hypothesis.length > 50 ? "…" : ""));
}

main();
