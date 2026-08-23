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
import { initLedgerSchema, listLedgerEntries } from "../../lib/ledger.js";

function main(): void {
  const args = parseCliArgs();
  const ledgerPath = discoverLedgerPath(args.get("ledger"));
  const json = boolArg(args, "json", false);
  const outDir = args.get("outDir");
  const limit = Math.max(1, numberArg(args, "limit", 50));
  const runId = args.get("runId");
  const checkName = args.get("checkName");

  const sqlite = openWritableDatabase(ledgerPath);
  initLedgerSchema(sqlite);
  const rows = listLedgerEntries(sqlite, { limit, runId, checkName });
  safeClose(sqlite);

  const payload = {
    ok: true,
    ledgerPath,
    count: rows.length,
    rows
  };

  const lines = [`[ledger] rows=${rows.length} path=${ledgerPath}`];
  for (const row of rows) {
    lines.push(
      `- id=${row.id} run_id=${row.runId} check=${row.checkName} verdict=${row.verdict} ts=${row.runTs}`
    );
  }

  emitScriptOutput(payload, lines, {
    json,
    outDir,
    outFileName: "ledger-list.json"
  });
}

main();

