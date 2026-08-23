#!/usr/bin/env tsx
import {
  boolArg,
  discoverLedgerPath,
  numberArg,
  parseCliArgs,
  safeClose,
  openWritableDatabase
} from "../../lib/db.js";
import { emitScriptOutput } from "../../lib/io.js";
import { initLedgerSchema, listLedgerEntries, summarizeLedger } from "../../lib/ledger.js";

function main(): void {
  const args = parseCliArgs();
  const ledgerPath = discoverLedgerPath(args.get("ledger"));
  const json = boolArg(args, "json", false);
  const outDir = args.get("outDir");
  const limit = Math.max(1, numberArg(args, "limit", 1000));
  const runId = args.get("runId");

  const sqlite = openWritableDatabase(ledgerPath);
  initLedgerSchema(sqlite);
  const rows = listLedgerEntries(sqlite, { limit, runId });
  safeClose(sqlite);

  const summary = summarizeLedger(rows);
  const payload = {
    ok: true,
    ledgerPath,
    limit,
    runId: runId ?? null,
    summary
  };

  const lines = [
    `[ledger-summary] ${ledgerPath}`,
    `Works: ${summary.works}`,
    `Doesn't: ${summary.doesnt}`,
    `Unclear: ${summary.unclear}`,
    `Total: ${summary.total}`
  ];

  if (summary.byCheck.length > 0) {
    lines.push("");
    lines.push("By check:");
    for (const row of summary.byCheck) {
      lines.push(
        `- ${row.checkName}: works=${row.works} doesnt=${row.doesnt} unclear=${row.unclear} total=${row.total}`
      );
    }
  }

  emitScriptOutput(payload, lines, {
    json,
    outDir,
    outFileName: "ledger-summary.json"
  });
}

main();

