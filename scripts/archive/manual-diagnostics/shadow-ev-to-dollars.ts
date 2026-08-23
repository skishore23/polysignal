#!/usr/bin/env npx tsx
/**
 * Shadow EV → expected $/day: per-bucket EV_bps, notional, and expected $/day.
 * Uses the same round-trip maker/taker cost logic as whatif-maker.
 *
 * Usage:
 *   npx tsx scripts/archive/manual-diagnostics/shadow-ev-to-dollars.ts --hours=24
 *   npx tsx scripts/archive/manual-diagnostics/shadow-ev-to-dollars.ts --hours=24 --by=spread
 *   npx tsx scripts/archive/manual-diagnostics/shadow-ev-to-dollars.ts --hours=24 --exitModel=maker --pFillOut=0.45
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../../packages/storage/src/index.js";

type Side = "BUY" | "SELL";

type FillRow = {
  fill_id: number;
  ts: number;
  wallet_id: number | null;
  token_id: string;
  side: Side;
  size: number;
  order_id: number;
  net_edge_bps: number | null;
  spread_bps: number | null;
  fees_bps: number | null;
};

type Trade = {
  wallet_id: string;
  token_id: string;
  dir: 1 | -1;
  open_ts: number;
  close_ts: number | null;
  size: number;
  entry_net_edge_bps: number | null;
  open_spread_bps: number | null;
  open_fees_bps: number | null;
  close_spread_bps: number | null;
  close_fees_bps: number | null;
};

function bucketSpread(rtSpreadBps: number): string {
  if (!Number.isFinite(rtSpreadBps) || rtSpreadBps < 0) return "unknown";
  if (rtSpreadBps <= 10) return "0-10";
  if (rtSpreadBps <= 25) return "10-25";
  if (rtSpreadBps <= 50) return "25-50";
  if (rtSpreadBps <= 100) return "50-100";
  if (rtSpreadBps <= 200) return "100-200";
  return "200+";
}

function dirFromSide(side: Side): 1 | -1 {
  return side === "BUY" ? 1 : -1;
}

function markoutBps(entryMid: number, exitMid: number, dir: 1 | -1): number {
  const pnlFrac =
    dir === 1 ? (exitMid - entryMid) / entryMid : (entryMid - exitMid) / entryMid;
  return pnlFrac * 10_000;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function makeKey(walletId: number | null, tokenId: string): string {
  return `${walletId ?? -1}::${tokenId}`;
}

type ExitMode = "maker" | "taker";

function spreadCapture(
  openSpread: number,
  closeSpread: number,
  entry: "maker" | "taker",
  exit: ExitMode
): number {
  if (entry === "maker" && exit === "maker") return openSpread + closeSpread;
  if (entry === "maker" && exit === "taker") return openSpread / 2 - closeSpread / 2;
  if (entry === "taker" && exit === "maker") return -openSpread / 2 + closeSpread / 2;
  return -(openSpread + closeSpread);
}

function makerCost(spreadCap: number, rtFees: number, adverseVal: number): number {
  return rtFees - spreadCap + adverseVal;
}

const parseArgs = (): Map<string, string> => {
  const map = new Map<string, string>();
  for (let i = 0; i < process.argv.length; i += 1) {
    const raw = process.argv[i];
    if (!raw?.startsWith("--")) continue;
    const eqIdx = raw.indexOf("=");
    if (eqIdx !== -1) {
      map.set(raw.slice(2, eqIdx), raw.slice(eqIdx + 1));
      continue;
    }
    const key = raw.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith("--")) {
      map.set(key, next);
      i += 1;
    } else {
      map.set(key, "true");
    }
  }
  return map;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const args = parseArgs();
const dbRaw = args.get("db") ?? "data/dev.db";
const dbPath = path.isAbsolute(dbRaw) ? dbRaw : path.join(repoRoot, dbRaw);
const hours = Math.max(1, Number(args.get("hours") ?? 24));
const horizon5m = 300_000;
const horizon10m = 600_000;
const pFillOut = Number(args.get("pFillOut") ?? 1);
const adverseK = Number(args.get("adverseK") ?? 0.25);
const exitRaw = args.get("exitModel") ?? "maker";
const exitMode: ExitMode = exitRaw === "taker" ? "taker" : "maker";
const bySpread = args.get("by") !== "wallet" && args.get("by") !== "token";

const sinceTs = Date.now() - hours * 60 * 60 * 1000;
const windowHours = hours;
const msPerDay = 24 * 60 * 60 * 1000;

const { sqlite } = openDatabase(dbPath);

const fills = sqlite
  .prepare(
    `SELECT f.id as fill_id, f.ts as ts, o.wallet_id as wallet_id, o.token_id as token_id,
            o.side as side, f.size as size, o.id as order_id,
            o.net_edge_bps as net_edge_bps, o.spread_bps as spread_bps, o.fees_bps as fees_bps
     FROM shadow_fills f
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE f.ts >= ? AND f.method != 'synthetic_fill'
       AND o.kind IN ('TAKER_BUY','TAKER_SELL') AND o.execution_mode = 'SHADOW'
     ORDER BY o.wallet_id, o.token_id, f.ts ASC`
  )
  .all(sinceTs) as FillRow[];

const midStmt = sqlite.prepare(
  `SELECT mid FROM features WHERE token_id = ? AND ts <= ? AND mid IS NOT NULL ORDER BY ts DESC LIMIT 1`
);
const midCache = new Map<string, number>();
function getMid(tokenId: string, ts: number): number | null {
  const key = `${tokenId}::${ts}`;
  const c = midCache.get(key);
  if (c != null) return c;
  const row = midStmt.get(tokenId, ts) as { mid: number } | undefined;
  if (!row?.mid || !Number.isFinite(row.mid)) return null;
  midCache.set(key, row.mid);
  if (midCache.size > 50_000) {
    const keys = [...midCache.keys()].slice(0, 10_000);
    keys.forEach((k) => midCache.delete(k));
  }
  return row.mid;
}

type PosState = { qty: number; trade: Trade | null };
const pos = new Map<string, PosState>();
const trades: Trade[] = [];

for (const f of fills) {
  const k = makeKey(f.wallet_id, f.token_id);
  const st = pos.get(k) ?? { qty: 0, trade: null };
  const size = Number(f.size) || 0;
  if (!Number.isFinite(size) || size <= 0) continue;
  const dq = dirFromSide(f.side) * size;
  const prevQty = st.qty;
  const nextQty = prevQty + dq;

  const closeTrade = (
    closeTs: number,
    closeSpread: number | null,
    closeFees: number | null
  ) => {
    if (st.trade) {
      st.trade.close_ts = closeTs;
      st.trade.close_spread_bps = closeSpread;
      st.trade.close_fees_bps = closeFees;
      trades.push(st.trade);
      st.trade = null;
    }
  };

  if (prevQty === 0 && nextQty !== 0) {
    st.trade = {
      wallet_id: String(f.wallet_id ?? -1),
      token_id: f.token_id,
      dir: nextQty > 0 ? 1 : -1,
      open_ts: f.ts,
      close_ts: null,
      size,
      entry_net_edge_bps: f.net_edge_bps,
      open_spread_bps: f.spread_bps,
      open_fees_bps: f.fees_bps,
      close_spread_bps: null,
      close_fees_bps: null
    };
  }
  if (prevQty !== 0 && nextQty !== 0 && Math.sign(prevQty) !== Math.sign(nextQty)) {
    closeTrade(f.ts, f.spread_bps, f.fees_bps);
    st.trade = {
      wallet_id: String(f.wallet_id ?? -1),
      token_id: f.token_id,
      dir: nextQty > 0 ? 1 : -1,
      open_ts: f.ts,
      close_ts: null,
      size,
      entry_net_edge_bps: f.net_edge_bps,
      open_spread_bps: f.spread_bps,
      open_fees_bps: f.fees_bps,
      close_spread_bps: null,
      close_fees_bps: null
    };
  }
  if (prevQty !== 0 && nextQty === 0) {
    closeTrade(f.ts, f.spread_bps, f.fees_bps);
  }
  st.qty = nextQty;
  pos.set(k, st);
}

type Row = {
  spread_bucket: string;
  bucket_key: string;
  notional: number;
  w5_gross_bps: number | null;
  w10_gross_bps: number | null;
  open_spread_bps: number;
  close_spread_bps: number;
  rt_spread_bps: number;
  rt_fees_bps: number;
};

const rows: Row[] = [];
for (const t of trades) {
  const entryMid = getMid(t.token_id, t.open_ts);
  if (entryMid == null || !Number.isFinite(entryMid) || entryMid <= 0) continue;
  const openSpread = t.open_spread_bps ?? 0;
  const closeSpread = t.close_spread_bps ?? t.open_spread_bps ?? 0;
  const rtSpread = openSpread + closeSpread;
  const rtFees = (t.open_fees_bps ?? 0) + (t.close_fees_bps ?? t.open_fees_bps ?? 0);
  const mid5 = getMid(t.token_id, t.open_ts + horizon5m);
  const mid10 = getMid(t.token_id, t.open_ts + horizon10m);
  const w5Gross = mid5 == null ? null : markoutBps(entryMid, mid5, t.dir);
  const w10Gross = mid10 == null ? null : markoutBps(entryMid, mid10, t.dir);
  const notional = t.size * entryMid;

  rows.push({
    spread_bucket: bucketSpread(rtSpread),
    bucket_key: bySpread ? bucketSpread(rtSpread) : t.wallet_id,
    notional,
    w5_gross_bps: w5Gross,
    w10_gross_bps: w10Gross,
    open_spread_bps: openSpread,
    close_spread_bps: closeSpread,
    rt_spread_bps: rtSpread,
    rt_fees_bps: rtFees
  });
}

const spreadOrder = ["0-10", "10-25", "25-50", "50-100", "100-200", "200+", "unknown"];
const buckets = bySpread
  ? Array.from(new Set(rows.map((r) => r.spread_bucket))).sort(
      (a, b) => spreadOrder.indexOf(a) - spreadOrder.indexOf(b)
    )
  : Array.from(new Set(rows.map((r) => r.bucket_key))).sort();
const bucketKey: keyof Row = bySpread ? "spread_bucket" : "bucket_key";

function reportBucket(bucketLabel: string, rs: Row[]): void {
  if (rs.length === 0) return;
  const fillsCount = rs.length;
  const notionalTotal = rs.reduce((s, r) => s + r.notional, 0);
  const notionalPerDay = (notionalTotal / windowHours) * 24;

  const w10With = rs.filter((r) => r.w10_gross_bps != null && Number.isFinite(r.w10_gross_bps));
  const w5With = rs.filter((r) => r.w5_gross_bps != null && Number.isFinite(r.w5_gross_bps));

  const netBps = (grossBps: number, r: Row): number => {
    const adv = adverseK > 0 ? adverseK * r.rt_spread_bps : 0;
    const cap = spreadCapture(r.open_spread_bps, r.close_spread_bps, "maker", exitMode);
    const fillFactor = exitMode === "maker" ? pFillOut : 1;
    return (grossBps - makerCost(cap, r.rt_fees_bps, adv)) * fillFactor;
  };
  const ev10Bps = w10With.length > 0 ? mean(w10With.map((r) => netBps(r.w10_gross_bps!, r))) : NaN;
  const ev5Bps = w5With.length > 0 ? mean(w5With.map((r) => netBps(r.w5_gross_bps!, r))) : NaN;

  const evBps = Number.isFinite(ev10Bps) ? ev10Bps : ev5Bps;
  const expectedDollarsPerDay = notionalPerDay * (evBps / 10_000);

  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "—");
  console.log(
    [
      bucketLabel.padEnd(12),
      `fills=${fillsCount}`,
      `notional_total=${fmt(notionalTotal)}`,
      `notional_per_day=${fmt(notionalPerDay)}`,
      `EV_bps_10m=${fmt(ev10Bps)}`,
      `EV_bps_5m=${fmt(ev5Bps)}`,
      `expected_$/day=${fmt(expectedDollarsPerDay)}`
    ].join(" | ")
  );
}

console.log(`[shadow-ev-to-dollars] DB: ${dbPath}`);
console.log(
  `[shadow-ev-to-dollars] Window: ${hours}h | exitModel=${exitMode} pFillOut=${pFillOut}`
);
console.log(`[shadow-ev-to-dollars] Trades: ${trades.length} | by=${bySpread ? "spread" : "wallet"}`);
console.log("");

reportBucket("OVERALL", rows);
for (const b of buckets) {
  reportBucket(b, rows.filter((r) => r[bucketKey] === b));
}

sqlite.close();
