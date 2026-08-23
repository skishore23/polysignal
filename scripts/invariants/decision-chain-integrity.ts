#!/usr/bin/env tsx

import {
  discoverDbPath,
  openReadOnlyDatabase,
  parseCliArgs,
  safeClose,
  stringArg,
  tableExists
} from "../lib/db.js";

const CHAIN_KINDS = ["MAKER_BID", "MAKER_ASK", "TAKER_BUY", "TAKER_SELL"] as const;

const args = parseCliArgs();
const dbPath = discoverDbPath(stringArg(args, "db", ""));
const sqlite = openReadOnlyDatabase(dbPath);

try {
  const requiredTables = ["shadow_orders", "decision_log", "shadow_markouts", "shadow_fills"];
  const missingTables = requiredTables.filter((name) => !tableExists(sqlite, name));
  if (missingTables.length > 0) {
    console.error(`[invariant:decision-chain-integrity] FAIL db=${dbPath}`);
    console.error(`  - missing tables: ${missingTables.join(", ")}`);
    process.exit(1);
  }

  const missingDecisionGroup = sqlite
    .prepare(
      `SELECT COUNT(*) as c
       FROM shadow_orders o
       WHERE o.kind IN (${CHAIN_KINDS.map(() => "?").join(",")})
         AND COALESCE(o.source, '') != 'arb_executor'
         AND COALESCE(o.strategy_lane, '') != 'ARB'
         AND COALESCE(o.decision_group_id, '') = ''`
    )
    .get(...CHAIN_KINDS) as { c: number };

  const missingDecisionLineage = sqlite
    .prepare(
      `SELECT COUNT(*) as c
       FROM shadow_orders o
       LEFT JOIN decision_log d
         ON d.decision_group_id = o.decision_group_id
        AND d.token_id = o.token_id
       WHERE o.kind IN (${CHAIN_KINDS.map(() => "?").join(",")})
         AND COALESCE(o.source, '') != 'arb_executor'
         AND COALESCE(o.strategy_lane, '') != 'ARB'
         AND COALESCE(o.decision_group_id, '') != ''
         AND d.id IS NULL`
    )
    .get(...CHAIN_KINDS) as { c: number };

  const orphanMarkouts = sqlite
    .prepare(
      `SELECT COUNT(*) as c
       FROM shadow_markouts m
       LEFT JOIN shadow_fills f ON f.id = m.fill_id
       WHERE f.id IS NULL`
    )
    .get() as { c: number };

  const failures: string[] = [];
  if ((missingDecisionGroup.c ?? 0) > 0) {
    failures.push(`missing decision_group_id rows=${missingDecisionGroup.c}`);
  }
  if ((missingDecisionLineage.c ?? 0) > 0) {
    failures.push(`unmapped decision lineage rows=${missingDecisionLineage.c}`);
  }
  if ((orphanMarkouts.c ?? 0) > 0) {
    failures.push(`orphan markouts rows=${orphanMarkouts.c}`);
  }

  if (failures.length > 0) {
    console.error(`[invariant:decision-chain-integrity] FAIL db=${dbPath}`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log(`[invariant:decision-chain-integrity] PASS db=${dbPath}`);
} finally {
  safeClose(sqlite);
}
