#!/usr/bin/env npx tsx
/**
 * Hold vs horizon: avg/median hold time, % closed within 5m/30m/1h, % still open.
 * Detects "accidentally a long-horizon trader."
 *
 * Usage:
 *   npx tsx scripts/archive/manual-diagnostics/validate-hold-horizon.ts --hours=24
 *   npx tsx scripts/archive/manual-diagnostics/validate-hold-horizon.ts --db=data/dev.db --hours=6 --primaryHorizonSec=300
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../../packages/storage/src/index.js";

function percentile(xs: number[], p: number): number {
  if (!xs.length || p < 0 || p > 1) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const i = p * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (i - lo) * (sorted[hi]! - sorted[lo]!);
}

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const args = parseArgs();
const hours = Math.max(1, Number(args.get("hours") ?? 24));
const primaryHorizonSec = Number(args.get("primaryHorizonSec") ?? 300);
const dbRaw = args.get("db") ?? "data/dev.db";
const dbPath = path.isAbsolute(dbRaw) ? dbRaw : path.join(repoRoot, dbRaw);

const { sqlite } = openDatabase(dbPath);
const now = Date.now();
const since = now - hours * 60 * 60 * 1000;

type FillRow = {
  walletId: number | null;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number | null;
  size: number | null;
  ts: number;
};

const fills = sqlite
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
       AND f.method != 'synthetic_fill'
       AND o.kind IN ('TAKER_BUY','TAKER_SELL')
       AND o.execution_mode = 'SHADOW'
     ORDER BY o.wallet_id ASC, o.token_id ASC, f.ts ASC`
  )
  .all(since) as FillRow[];

type State = {
  position: number;
  openTs: number | null;
  holdSecs: number[];
};

const states = new Map<string, State>();

for (const fill of fills) {
  if (!Number.isFinite(fill.price) || !Number.isFinite(fill.size)) continue;
  const key = `${fill.walletId ?? -1}:${fill.tokenId}`;
  let state = states.get(key);
  if (!state) {
    state = { position: 0, openTs: null, holdSecs: [] };
  }

  const delta = fill.side === "BUY" ? (fill.size ?? 0) : -(fill.size ?? 0);
  const nextPos = state.position + delta;
  const wasOpen = state.position !== 0;
  const opensNow = state.position === 0 && nextPos !== 0;
  const closesNow = wasOpen && nextPos === 0;
  const flips =
    wasOpen && nextPos !== 0 && Math.sign(state.position) !== Math.sign(nextPos);

  if (opensNow) {
    state.openTs = fill.ts;
  }

  if (closesNow || flips) {
    if (state.openTs != null) {
      const holdSec = (fill.ts - state.openTs) / 1000;
      state.holdSecs.push(holdSec);
    }
    state.openTs = flips ? fill.ts : null;
  }

  state.position = nextPos;
  states.set(key, state);
}

const holdSecs: number[] = [];
let closedWithin5m = 0;
let closedWithin30m = 0;
let closedWithin1h = 0;
let stillOpen = 0;

for (const state of states.values()) {
  for (const h of state.holdSecs) {
    holdSecs.push(h);
    if (h <= 300) closedWithin5m += 1;
    if (h <= 1800) closedWithin30m += 1;
    if (h <= 3600) closedWithin1h += 1;
  }
  if (state.position !== 0) stillOpen += 1;
}

const totalClosed = holdSecs.length;
const totalPositions = totalClosed + stillOpen;
const avgHoldSec = totalClosed > 0 ? holdSecs.reduce((a, b) => a + b, 0) / totalClosed : 0;
const medianHoldSec = totalClosed > 0 ? percentile(holdSecs, 0.5) : 0;
const pctClosed5m = totalClosed > 0 ? (closedWithin5m / totalClosed) * 100 : 0;
const pctClosed30m = totalClosed > 0 ? (closedWithin30m / totalClosed) * 100 : 0;
const pctClosed1h = totalClosed > 0 ? (closedWithin1h / totalClosed) * 100 : 0;
const pctStillOpen = totalPositions > 0 ? (stillOpen / totalPositions) * 100 : 0;

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "—");

console.log(`[hold-horizon] DB: ${dbPath}`);
console.log(`[hold-horizon] window: last ${hours}h | primaryHorizonSec: ${primaryHorizonSec}`);
console.log(`[hold-horizon] taker fills: ${fills.length}`);
console.log("");
console.log("Closed positions (hold time, sec):");
console.log(`  avg: ${fmt(avgHoldSec)} | median: ${fmt(medianHoldSec)} | n: ${totalClosed}`);
console.log("");
console.log("Hold time distribution:");
console.log(`  % closed within 5m:  ${fmt(pctClosed5m)}%`);
console.log(`  % closed within 30m: ${fmt(pctClosed30m)}%`);
console.log(`  % closed within 1h:  ${fmt(pctClosed1h)}%`);
console.log(`  % still open at window end: ${fmt(pctStillOpen)}%`);
console.log("");

if (totalClosed > 0 && avgHoldSec > 2 * primaryHorizonSec) {
  console.log(
    `>>> Horizon mismatch: avgHoldSec (${fmt(avgHoldSec)}) > 2 * primaryHorizonSec (${primaryHorizonSec}). ` +
      "Holding much longer than markout horizon."
  );
  console.log("");
}

sqlite.close();
