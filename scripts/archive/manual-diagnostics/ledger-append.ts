#!/usr/bin/env tsx
import {
  boolArg,
  configHash,
  discoverLedgerPath,
  parseCliArgs,
  safeClose,
  shortGitHash,
  stringArg,
  toIsoRunId,
  openWritableDatabase
} from "../../lib/db.js";
import { emitScriptOutput } from "../../lib/io.js";
import { appendLedgerEntry, initLedgerSchema, type LedgerVerdict } from "../../lib/ledger.js";

const ALLOWED_VERDICTS = new Set<LedgerVerdict>([
  "pass",
  "fail",
  "inconclusive",
  "works",
  "doesnt",
  "unclear",
  "killed"
]);

function maybeJson(raw: string | undefined): string | null {
  if (raw == null || raw === "") return null;
  try {
    JSON.parse(raw);
    return raw;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON: ${message}`);
  }
}

function main(): void {
  const args = parseCliArgs();
  const ledgerPath = discoverLedgerPath(args.get("ledger"));
  const json = boolArg(args, "json", false);
  const outDir = args.get("outDir");

  const runTs = Number(args.get("runTs") ?? Date.now());
  if (!Number.isFinite(runTs) || runTs <= 0) {
    throw new Error("--runTs must be a positive integer timestamp (ms)");
  }

  const gitHash = args.get("gitHash") ?? shortGitHash();
  const cfgHash = args.get("configHash") ?? configHash();
  const runId = args.get("runId") ?? toIsoRunId(runTs, gitHash);
  const checkName = stringArg(args, "checkName", "manual.entry");
  const hypothesis = args.get("hypothesis") ?? null;
  const verdict = stringArg(args, "verdict", "inconclusive") as LedgerVerdict;
  if (!ALLOWED_VERDICTS.has(verdict)) {
    throw new Error(
      `--verdict must be one of: ${Array.from(ALLOWED_VERDICTS.values()).join(", ")}`
    );
  }

  const paramsJson = maybeJson(args.get("paramsJson") ?? args.get("params"));
  const sampleJson = maybeJson(args.get("sampleJson") ?? args.get("sample"));
  const resultsJson = maybeJson(args.get("resultsJson") ?? args.get("results"));
  const nextAction = args.get("nextAction") ?? null;
  const artifactsPath = args.get("artifactsPath") ?? null;

  const sqlite = openWritableDatabase(ledgerPath);
  initLedgerSchema(sqlite);
  const id = appendLedgerEntry(sqlite, {
    runId,
    runTs,
    gitHash: gitHash ?? null,
    configHash: cfgHash ?? null,
    checkName,
    hypothesis,
    paramsJson,
    sampleJson,
    resultsJson,
    verdict,
    nextAction,
    artifactsPath
  });
  safeClose(sqlite);

  const payload = {
    ok: true,
    id,
    runId,
    runTs,
    ledgerPath,
    checkName,
    verdict
  };
  emitScriptOutput(payload, [`[ledger] appended id=${id} runId=${runId} check=${checkName}`], {
    json,
    outDir,
    outFileName: "ledger-append.json"
  });
}

main();

