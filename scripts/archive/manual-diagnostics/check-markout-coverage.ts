#!/usr/bin/env npx tsx
/**
 * Markout coverage check: fill counts, markout rows, join integrity, missing reasons.
 * Turns "we're missing markouts" into "no feature at fill_ts" etc. — actionable.
 *
 * Usage:
 *   npx tsx scripts/archive/manual-diagnostics/check-markout-coverage.ts --hours=24
 *   npx tsx scripts/archive/manual-diagnostics/check-markout-coverage.ts --db=data/dev.db --hours=6 --horizons=5000,30000,300000
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../../packages/storage/src/index.js";

type CountRow = { c: number };

const parseArgs = (): Map<string, string> => {
  const map = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const eqIdx = raw.indexOf("=");
    if (eqIdx !== -1) {
      map.set(raw.slice(2, eqIdx), raw.slice(eqIdx + 1));
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      map.set(key, next);
      i += 1;
      continue;
    }
    map.set(key, "true");
  }
  return map;
};

const args = parseArgs();
const hours = Math.max(1, Number(args.get("hours") ?? 24));
const horizons = (args.get("horizons") ?? "5000,30000,300000")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v > 0);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dbRaw = args.get("db") ?? "data/dev.db";
const dbPath = path.isAbsolute(dbRaw) ? dbRaw : path.join(repoRoot, dbRaw);

const { sqlite } = openDatabase(dbPath);
const now = Date.now();
const since = now - hours * 60 * 60 * 1000;

const totalMakerFills = (sqlite.prepare(
  `SELECT COUNT(*) as c
   FROM shadow_fills f
   JOIN shadow_orders o ON o.id = f.order_id
   WHERE f.ts >= ?
     AND o.kind IN ('MAKER_BID','MAKER_ASK')
     AND o.execution_mode = 'SHADOW'
     AND f.method != 'synthetic_fill'`
).get(since) as CountRow).c;

const totalTakerFills = (sqlite.prepare(
  `SELECT COUNT(*) as c
   FROM shadow_fills f
   JOIN shadow_orders o ON o.id = f.order_id
   WHERE f.ts >= ?
     AND o.kind IN ('TAKER_BUY','TAKER_SELL')
     AND o.execution_mode = 'SHADOW'
     AND f.method != 'synthetic_fill'`
).get(since) as CountRow).c;

console.log(`[markout-coverage] DB: ${dbPath}`);
console.log(`[markout-coverage] window: last ${hours}h`);
console.log(`[markout-coverage] fill counts: maker=${totalMakerFills} taker=${totalTakerFills}`);

const featureAtOrBeforeStmt = sqlite.prepare(
  `SELECT 1 as ok FROM features WHERE token_id = ? AND ts <= ? AND mid IS NOT NULL LIMIT 1`
);
const featureAtOrAfterStmt = sqlite.prepare(
  `SELECT 1 as ok FROM features WHERE token_id = ? AND ts >= ? AND mid IS NOT NULL LIMIT 1`
);

for (const horizonMs of horizons) {
  const makerMarked = (sqlite.prepare(
    `SELECT COUNT(DISTINCT m.fill_id) as c
     FROM shadow_markouts m
     JOIN shadow_fills f ON f.id = m.fill_id
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE m.ts >= ?
       AND m.horizon_ms = ?
       AND o.kind IN ('MAKER_BID','MAKER_ASK')
       AND o.execution_mode = 'SHADOW'`
  ).get(since, horizonMs) as CountRow).c;

  const makerMarkoutRows = (sqlite.prepare(
    `SELECT COUNT(*) as c
     FROM shadow_markouts m
     JOIN shadow_fills f ON f.id = m.fill_id
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE m.ts >= ?
       AND m.horizon_ms = ?
       AND o.kind IN ('MAKER_BID','MAKER_ASK')
       AND o.execution_mode = 'SHADOW'`
  ).get(since, horizonMs) as CountRow).c;

  const takerMarked = (sqlite.prepare(
    `SELECT COUNT(DISTINCT m.fill_id) as c
     FROM shadow_markouts m
     JOIN shadow_fills f ON f.id = m.fill_id
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE m.ts >= ?
       AND m.horizon_ms = ?
       AND o.kind IN ('TAKER_BUY','TAKER_SELL')
       AND o.execution_mode = 'SHADOW'`
  ).get(since, horizonMs) as CountRow).c;

  const takerMarkoutRows = (sqlite.prepare(
    `SELECT COUNT(*) as c
     FROM shadow_markouts m
     JOIN shadow_fills f ON f.id = m.fill_id
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE m.ts >= ?
       AND m.horizon_ms = ?
       AND o.kind IN ('TAKER_BUY','TAKER_SELL')
       AND o.execution_mode = 'SHADOW'`
  ).get(since, horizonMs) as CountRow).c;

  const makerRate = totalMakerFills > 0 ? (makerMarked / totalMakerFills) * 100 : 0;
  const takerRate = totalTakerFills > 0 ? (takerMarked / totalTakerFills) * 100 : 0;

  console.log(`[markout-coverage] horizon ${horizonMs}ms:`);
  console.log(`  maker: ${makerMarked}/${totalMakerFills} fills (${makerRate.toFixed(2)}%) | markout rows: ${makerMarkoutRows} | join: rows ${makerMarkoutRows === makerMarked ? "== distinct fills" : "!= distinct (BUG)"}`);
  console.log(`  taker: ${takerMarked}/${totalTakerFills} fills (${takerRate.toFixed(2)}%) | markout rows: ${takerMarkoutRows} | join: rows ${takerMarkoutRows === takerMarked ? "== distinct fills" : "!= distinct (BUG)"}`);

  const cutoff = now - horizonMs;
  const takerFillsWithoutMarkout = sqlite
    .prepare(
      `SELECT f.id as fillId, f.ts as fillTs, o.token_id as tokenId
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       LEFT JOIN shadow_markouts m ON m.fill_id = f.id AND m.horizon_ms = ?
       WHERE f.ts >= ? AND f.ts <= ?
         AND f.method != 'synthetic_fill'
         AND o.kind IN ('TAKER_BUY','TAKER_SELL')
         AND o.execution_mode = 'SHADOW'
         AND m.id IS NULL`
    )
    .all(horizonMs, since, cutoff) as Array<{ fillId: number; fillTs: number; tokenId: string }>;

  let noFeatAtFill = 0;
  let noFeatAtHorizon = 0;
  let bothMissing = 0;
  for (const row of takerFillsWithoutMarkout) {
    const hasFeatFill = !!featureAtOrBeforeStmt.get(row.tokenId, row.fillTs);
    const hasFeatHorizon = !!featureAtOrAfterStmt.get(row.tokenId, row.fillTs + horizonMs);
    if (!hasFeatFill && !hasFeatHorizon) bothMissing += 1;
    else if (!hasFeatFill) noFeatAtFill += 1;
    else if (!hasFeatHorizon) noFeatAtHorizon += 1;
  }

  if (takerFillsWithoutMarkout.length > 0) {
    console.log(`  missing markouts (taker, horizon passed): ${takerFillsWithoutMarkout.length}`);
    console.log(`    no feature at fill_ts: ${noFeatAtFill}`);
    console.log(`    no feature at fill_ts+horizon: ${noFeatAtHorizon}`);
    console.log(`    both missing: ${bothMissing}`);
  }
}

sqlite.close();
