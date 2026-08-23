#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  boolArg,
  discoverDbPath,
  openReadOnlyDatabase,
  parseCliArgs,
  resolveRepoRoot,
  safeClose,
  stringArg,
  tableExists
} from "../lib/db.js";

type AppendOnlySnapshot = {
  version: 1;
  capturedAtIso: string;
  protectedMaxId: number;
  protectedRowCount: number;
  protectedHash: string;
  fullRowCount: number;
  fullMaxId: number;
};

type HashResult = {
  rowCount: number;
  maxId: number;
  hash: string;
};

const args = parseCliArgs();
const dbPath = discoverDbPath(stringArg(args, "db", ""));
const updateSnapshot = boolArg(args, "update", true);
const allowEmptyRebase = boolArg(args, "allow-empty-rebase", false);
const snapshotArg = stringArg(
  args,
  "snapshot",
  "data/invariants/decision-log-append-only.snapshot.json"
);
const snapshotPath = path.isAbsolute(snapshotArg)
  ? snapshotArg
  : path.join(resolveRepoRoot(), snapshotArg);

const sqlite = openReadOnlyDatabase(dbPath);

const hashRows = (maxIdInclusive?: number): HashResult => {
  const where = maxIdInclusive == null ? "" : "WHERE id <= ?";
  const stmt = sqlite.prepare(
    `SELECT
       id,
       ts,
       token_id as tokenId,
       wallet_id as walletId,
       kind,
       strategy_lane as strategyLane,
       decision_group_id as decisionGroupId,
       decision,
       decision_reason as decisionReason,
       pred_edge_bps as predEdgeBps,
       net_edge_bps as netEdgeBps,
       size
     FROM decision_log
     ${where}
     ORDER BY id ASC`
  );
  const iter =
    maxIdInclusive == null
      ? (stmt.iterate() as Iterable<any>)
      : (stmt.iterate(maxIdInclusive) as Iterable<any>);
  const hash = createHash("sha256");
  let rowCount = 0;
  let maxId = 0;
  for (const row of iter) {
    rowCount += 1;
    maxId = Math.max(maxId, Number(row.id) || 0);
    hash.update(
      [
        row.id,
        row.ts,
        row.tokenId,
        row.walletId ?? "",
        row.kind,
        row.strategyLane ?? "",
        row.decisionGroupId ?? "",
        row.decision,
        row.decisionReason ?? "",
        row.predEdgeBps ?? "",
        row.netEdgeBps ?? "",
        row.size ?? ""
      ].join("|")
    );
    hash.update("\n");
  }
  return {
    rowCount,
    maxId,
    hash: hash.digest("hex")
  };
};

const writeSnapshot = (full: HashResult): void => {
  const payload: AppendOnlySnapshot = {
    version: 1,
    capturedAtIso: new Date().toISOString(),
    protectedMaxId: full.maxId,
    protectedRowCount: full.rowCount,
    protectedHash: full.hash,
    fullRowCount: full.rowCount,
    fullMaxId: full.maxId
  };
  mkdirSync(path.dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
};

try {
  if (!tableExists(sqlite, "decision_log")) {
    console.error(`[invariant:decision-log-append-only] FAIL db=${dbPath} missing table decision_log`);
    process.exit(1);
  }

  if (!existsSync(snapshotPath)) {
    const full = hashRows();
    if (updateSnapshot) {
      writeSnapshot(full);
    }
    console.log(
      `[invariant:decision-log-append-only] PASS initialized snapshot=${snapshotPath} rows=${full.rowCount}`
    );
    process.exit(0);
  }

  const previous = JSON.parse(readFileSync(snapshotPath, "utf-8")) as AppendOnlySnapshot;
  const historical = hashRows(previous.protectedMaxId);
  const full = hashRows();

  const failures: string[] = [];
  if (historical.rowCount !== previous.protectedRowCount) {
    failures.push(
      `protected row count changed expected=${previous.protectedRowCount} actual=${historical.rowCount}`
    );
  }
  if (historical.hash !== previous.protectedHash) {
    failures.push(`protected hash mismatch expected=${previous.protectedHash} actual=${historical.hash}`);
  }
  if (full.maxId < previous.protectedMaxId) {
    failures.push(`max id regressed expected>=${previous.protectedMaxId} actual=${full.maxId}`);
  }

  if (failures.length > 0) {
    const canEmptyRebase =
      allowEmptyRebase &&
      full.rowCount === 0 &&
      full.maxId === 0 &&
      previous.protectedRowCount > 0;
    if (canEmptyRebase) {
      if (updateSnapshot) {
        writeSnapshot(full);
      }
      console.log(
        `[invariant:decision-log-append-only] PASS rebased-empty db=${dbPath} snapshot=${snapshotPath}`
      );
      process.exit(0);
    }
    console.error(`[invariant:decision-log-append-only] FAIL db=${dbPath} snapshot=${snapshotPath}`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  if (updateSnapshot) {
    writeSnapshot(full);
  }
  console.log(
    `[invariant:decision-log-append-only] PASS db=${dbPath} rows=${full.rowCount} max_id=${full.maxId}`
  );
} finally {
  safeClose(sqlite);
}
