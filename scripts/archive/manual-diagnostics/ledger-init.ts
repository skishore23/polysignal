#!/usr/bin/env tsx
import {
  boolArg,
  discoverLedgerPath,
  parseCliArgs,
  safeClose,
  stringArg,
  openWritableDatabase
} from "../../lib/db.js";
import { emitScriptOutput } from "../../lib/io.js";
import { initLedgerSchema } from "../../lib/ledger.js";

function main(): void {
  const args = parseCliArgs();
  const ledgerPath = discoverLedgerPath(args.get("ledger"));
  const json = boolArg(args, "json", false);
  const outDir = args.get("outDir");
  const note = stringArg(args, "note", "");

  const sqlite = openWritableDatabase(ledgerPath);
  initLedgerSchema(sqlite);
  safeClose(sqlite);

  const payload = {
    ok: true,
    ledgerPath,
    note: note || null,
    message: "Ledger initialized"
  };

  emitScriptOutput(payload, [`[ledger] initialized ${ledgerPath}`], {
    json,
    outDir,
    outFileName: "ledger-init.json"
  });
}

main();

