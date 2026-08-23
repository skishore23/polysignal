#!/usr/bin/env tsx

import {
  buildShadowPositionLedger,
  type ShadowFillInput
} from "../../packages/data/src/shadowPositionLedger";
import {
  discoverDbPath,
  numberArg,
  openReadOnlyDatabase,
  parseCliArgs,
  safeClose,
  stringArg,
  tableExists
} from "../lib/db.js";

const args = parseCliArgs();
const dbPath = discoverDbPath(stringArg(args, "db", ""));
const windowHours = Math.max(1, numberArg(args, "window-hours", 24));
const minCloseRatio = Math.max(0, numberArg(args, "min-close-ratio", 0.15));
const maxOneSided = Math.min(1, Math.max(0, numberArg(args, "max-one-sided", 0.85)));
const sinceTs = Date.now() - windowHours * 60 * 60 * 1000;

const sqlite = openReadOnlyDatabase(dbPath);

try {
  const requiredTables = ["shadow_orders", "shadow_fills"];
  const missing = requiredTables.filter((tableName) => !tableExists(sqlite, tableName));
  if (missing.length > 0) {
    console.error(`[invariant:taker-close-balance] FAIL db=${dbPath}`);
    console.error(`  - missing tables: ${missing.join(", ")}`);
    process.exit(1);
  }

  const rows = sqlite
    .prepare(
      `SELECT
         o.wallet_id as walletId,
         o.token_id as tokenId,
         o.side as side,
         f.price as price,
         f.size as size,
         f.ts as ts
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE f.ts >= ?
         AND o.kind IN ('TAKER_BUY', 'TAKER_SELL')
         AND (f.method IS NULL OR f.method != 'synthetic_fill')
       ORDER BY f.ts ASC`
    )
    .all(sinceTs) as Array<{
    walletId: number;
    tokenId: string;
    side: string;
    price: number;
    size: number;
    ts: number;
  }>;

  const fills: ShadowFillInput[] = [];
  const sideByGroup = new Map<string, { buy: boolean; sell: boolean }>();
  for (const row of rows) {
    if (row.side !== "BUY" && row.side !== "SELL") continue;
    fills.push({
      walletId: row.walletId,
      tokenId: row.tokenId,
      side: row.side,
      price: row.price,
      size: row.size,
      ts: row.ts
    });
    const key = `${row.walletId}:${row.tokenId}`;
    const sideState = sideByGroup.get(key) ?? { buy: false, sell: false };
    if (row.side === "BUY") sideState.buy = true;
    if (row.side === "SELL") sideState.sell = true;
    sideByGroup.set(key, sideState);
  }

  const states = buildShadowPositionLedger(fills);
  let openedCycles = 0;
  let closedCycles = 0;
  for (const state of states.values()) {
    openedCycles += state.openedCycles;
    closedCycles += state.closedCycles;
  }
  const closeRatio = openedCycles > 0 ? closedCycles / openedCycles : 0;

  let activeGroups = 0;
  let oneSidedGroups = 0;
  for (const sideState of sideByGroup.values()) {
    if (!sideState.buy && !sideState.sell) continue;
    activeGroups += 1;
    if (sideState.buy !== sideState.sell) oneSidedGroups += 1;
  }
  const oneSidedRatio = activeGroups > 0 ? oneSidedGroups / activeGroups : 0;

  const failures: string[] = [];
  if (closeRatio < minCloseRatio) {
    failures.push(`close ratio below threshold actual=${closeRatio.toFixed(6)} required>=${minCloseRatio.toFixed(6)}`);
  }
  if (oneSidedRatio > maxOneSided) {
    failures.push(`one-sided ratio above threshold actual=${oneSidedRatio.toFixed(6)} max<=${maxOneSided.toFixed(6)}`);
  }

  if (failures.length > 0) {
    console.error(`[invariant:taker-close-balance] FAIL db=${dbPath}`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    console.error(
      `  - opened_cycles=${openedCycles} closed_cycles=${closedCycles} active_groups=${activeGroups} one_sided_groups=${oneSidedGroups}`
    );
    process.exit(1);
  }

  console.log(
    `[invariant:taker-close-balance] PASS db=${dbPath} window_hours=${windowHours} close_ratio=${closeRatio.toFixed(6)} one_sided_ratio=${oneSidedRatio.toFixed(6)}`
  );
} finally {
  safeClose(sqlite);
}
