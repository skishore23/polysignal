#!/usr/bin/env npx tsx
/**
 * Maker what-if: same taker round-trips, but assume maker execution.
 * Maker captures spread (fills at touch), pays fees, no slippage.
 * Answers: "If we had posted instead of crossed, would these trades be profitable?"
 *
 * Model: spread_capture = f(entry,exit); cost = fees + adverse - spread_capture
 *        net = gross - cost = gross + spread_capture - fees - adverse
 *
 * Usage:
 *   npx tsx scripts/archive/manual-diagnostics/whatif-maker.ts --hours=24
 *   npx tsx scripts/archive/manual-diagnostics/whatif-maker.ts --hours=24 --by=spread
 *   npx tsx scripts/archive/manual-diagnostics/whatif-maker.ts --hours=24 --entry=maker --exit=taker   # maker→taker (~gross)
 *   npx tsx scripts/archive/manual-diagnostics/whatif-maker.ts --hours=24 --adverseBps=10
 *   npx tsx scripts/archive/manual-diagnostics/whatif-maker.ts --hours=24 --adverseK=0.25   # adverse = k * rt_spread
 *   npx tsx scripts/archive/manual-diagnostics/whatif-maker.ts --hours=24 --pFillIn=0.5 --pFillOut=0.3
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
  entry_net_edge_bps: number | null;
  open_spread_bps: number | null;
  open_fees_bps: number | null;
  close_spread_bps: number | null;
  close_fees_bps: number | null;
};

function bucketNetEdge(netEdgeBps: number | null): string {
  if (netEdgeBps == null || !Number.isFinite(netEdgeBps)) return "unknown";
  if (netEdgeBps < 10) return "0-10";
  if (netEdgeBps < 25) return "10-25";
  if (netEdgeBps < 50) return "25-50";
  return "50+";
}

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

function pctFinite(xs: Array<number | null | undefined>): number {
  const n = xs.length;
  const k = xs.filter((x) => x != null && Number.isFinite(x)).length;
  return n === 0 ? 0 : (k / n) * 100;
}

function makeKey(walletId: number | null, tokenId: string): string {
  return `${walletId ?? -1}::${tokenId}`;
}

type EntryMode = "maker" | "taker";
type ExitMode = "maker" | "taker";

function spreadCapture(
  openSpread: number,
  closeSpread: number,
  entry: EntryMode,
  exit: ExitMode
): number {
  if (entry === "maker" && exit === "maker") return openSpread + closeSpread;
  if (entry === "maker" && exit === "taker") return openSpread / 2 - closeSpread / 2;
  if (entry === "taker" && exit === "maker") return -openSpread / 2 + closeSpread / 2;
  return -(openSpread + closeSpread);
}

function adverse(rtSpread: number, adverseBps: number, adverseK: number): number {
  if (adverseK > 0) return adverseK * rtSpread;
  return adverseBps;
}

function makerCost(
  spreadCap: number,
  rtFees: number,
  adverseVal: number
): number {
  return rtFees - spreadCap + adverseVal;
}

const parseArgs = (): Map<string, string> => {
  const map = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw?.startsWith("--")) continue;
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
const dbRaw = args.get("db") ?? "data/dev.db";
const dbPath = path.isAbsolute(dbRaw) ? dbRaw : path.join(repoRoot, dbRaw);
const hours = Math.max(1, Number(args.get("hours") ?? 24));
const horizon5m = Number(args.get("h5m") ?? 300000);
const horizon10m = Number(args.get("h10m") ?? 600000);
const includeOpen = args.get("includeOpen") === "true";
const adverseBps = Number(args.get("adverseBps") ?? 0);
const adverseK = Number(args.get("adverseK") ?? 0);
const pFillIn = Number(args.get("pFillIn") ?? 1);
const pFillOut = Number(args.get("pFillOut") ?? 1);
const entryRaw = args.get("entry") ?? "maker";
const exitRaw = args.get("exit") ?? "maker";
const entryMode: EntryMode = entryRaw === "taker" ? "taker" : "maker";
const exitMode: ExitMode = exitRaw === "taker" ? "taker" : "maker";
const bySpread = args.get("by") === "spread";

const sinceTs = Date.now() - hours * 60 * 60 * 1000;

const { sqlite } = openDatabase(dbPath);

const fills = sqlite
  .prepare(
    `SELECT
       f.id as fill_id,
       f.ts as ts,
       o.wallet_id as wallet_id,
       o.token_id as token_id,
       o.side as side,
       f.size as size,
       o.id as order_id,
       o.net_edge_bps as net_edge_bps,
       o.spread_bps as spread_bps,
       o.fees_bps as fees_bps
     FROM shadow_fills f
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE f.ts >= ?
       AND f.method != 'synthetic_fill'
       AND o.kind IN ('TAKER_BUY','TAKER_SELL')
       AND o.execution_mode = 'SHADOW'
     ORDER BY o.wallet_id, o.token_id, f.ts ASC`
  )
  .all(sinceTs) as FillRow[];

const midStmt = sqlite.prepare(
  `SELECT mid FROM features
   WHERE token_id = ? AND ts <= ? AND mid IS NOT NULL
   ORDER BY ts DESC LIMIT 1`
);

const midCache = new Map<string, number>();
function getMid(tokenId: string, ts: number): number | null {
  const key = `${tokenId}::${ts}`;
  const cached = midCache.get(key);
  if (cached != null) return cached;

  const row = midStmt.get(tokenId, ts) as { mid: number } | undefined;
  if (!row || row.mid == null || !Number.isFinite(row.mid)) return null;
  midCache.set(key, row.mid);
  if (midCache.size > 50_000) {
    let i = 0;
    for (const k of midCache.keys()) {
      midCache.delete(k);
      if (++i > 5_000) break;
    }
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

if (includeOpen) {
  for (const st of pos.values()) {
    if (st.trade && st.trade.close_ts == null) trades.push(st.trade);
  }
}

type RowOut = {
  bucket: string;
  spread_bucket: string;
  open_spread_bps: number;
  close_spread_bps: number;
  rt_spread_bps: number;
  rt_fees_bps: number;
  actual_gross_bps: number | null;
  w5_gross_bps: number | null;
  w10_gross_bps: number | null;
};

const rows: RowOut[] = [];
for (const t of trades) {
  const entryMid = getMid(t.token_id, t.open_ts);
  if (entryMid == null) continue;

  const openSpread = t.open_spread_bps ?? 0;
  const closeSpread = t.close_spread_bps ?? t.open_spread_bps ?? 0;
  const rtSpread = openSpread + closeSpread;
  const rtFees = (t.open_fees_bps ?? 0) + (t.close_fees_bps ?? t.open_fees_bps ?? 0);

  let actualGross: number | null = null;
  if (t.close_ts != null) {
    const exitMid = getMid(t.token_id, t.close_ts);
    if (exitMid != null) actualGross = markoutBps(entryMid, exitMid, t.dir);
  }

  const mid5 = getMid(t.token_id, t.open_ts + horizon5m);
  const mid10 = getMid(t.token_id, t.open_ts + horizon10m);

  const w5Gross = mid5 == null ? null : markoutBps(entryMid, mid5, t.dir);
  const w10Gross = mid10 == null ? null : markoutBps(entryMid, mid10, t.dir);

  rows.push({
    bucket: bucketNetEdge(t.entry_net_edge_bps),
    spread_bucket: bucketSpread(rtSpread),
    open_spread_bps: openSpread,
    close_spread_bps: closeSpread,
    rt_spread_bps: rtSpread,
    rt_fees_bps: rtFees,
    actual_gross_bps: actualGross,
    w5_gross_bps: w5Gross,
    w10_gross_bps: w10Gross
  });
}

const netEdgeOrder = ["0-10", "10-25", "25-50", "50+", "unknown"];
const spreadOrder = ["0-10", "10-25", "25-50", "50-100", "100-200", "200+", "unknown"];

const netEdgeBuckets = Array.from(new Set(rows.map((r) => r.bucket))).sort(
  (a, b) => netEdgeOrder.indexOf(a) - netEdgeOrder.indexOf(b)
);
const spreadBuckets = Array.from(new Set(rows.map((r) => r.spread_bucket))).sort(
  (a, b) => spreadOrder.indexOf(a) - spreadOrder.indexOf(b)
);
const buckets = bySpread ? spreadBuckets : netEdgeBuckets;
const bucketKey: keyof RowOut = bySpread ? "spread_bucket" : "bucket";

function summarize(label: string, rs: RowOut[]): void {
  const pFill = pFillIn * pFillOut;

  const cost = (r: RowOut, exit: ExitMode) => {
    const cap = spreadCapture(
      r.open_spread_bps,
      r.close_spread_bps,
      entryMode,
      exit
    );
    const adv = adverse(r.rt_spread_bps, adverseBps, adverseK);
    return makerCost(cap, r.rt_fees_bps, adv);
  };

  const actualPairs = rs
    .filter((r) => r.actual_gross_bps != null)
    .map((r) => ({ gross: r.actual_gross_bps!, r }));
  const actualNet = actualPairs.map((p) => (p.gross - cost(p.r, exitMode)) * pFill);

  const w5Pairs = rs
    .filter((r) => r.w5_gross_bps != null)
    .map((r) => ({ gross: r.w5_gross_bps!, r }));
  const w10Pairs = rs
    .filter((r) => r.w10_gross_bps != null)
    .map((r) => ({ gross: r.w10_gross_bps!, r }));

  const w5Net = w5Pairs.map((p) => (p.gross - cost(p.r, exitMode)) * pFill);
  const w10Net = w10Pairs.map((p) => (p.gross - cost(p.r, exitMode)) * pFill);

  const rtSpread = rs.map((r) => r.rt_spread_bps);
  const rtFees = rs.map((r) => r.rt_fees_bps);
  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "—");
  const modeLabel = `${entryMode}→${exitMode}`;
  const line = [
    label.padEnd(10),
    `n=${rs.length.toString().padStart(5)}`,
    `w5_gross=${fmt(mean(w5Pairs.map((p) => p.gross)))} rt_spread=${fmt(mean(rtSpread))} w5_net=${fmt(mean(w5Net))} (${modeLabel} pFill=${pFill.toFixed(2)})`,
    `w10_net=${fmt(mean(w10Net))} | actual_net mean=${fmt(mean(actualNet))} cov=${pctFinite(rs.map((r) => r.actual_gross_bps)).toFixed(1)}%`
  ].join(" | ");
  console.log(line);
}

console.log(`[whatif-maker] DB: ${dbPath}`);
console.log(`[whatif-maker] Window: last ${hours}h | sinceTs=${sinceTs}`);
console.log(`[whatif-maker] Trades: ${trades.length} (includeOpen=${includeOpen})`);
console.log(
  `[whatif-maker] entry=${entryMode} exit=${exitMode} pFillIn=${pFillIn} pFillOut=${pFillOut}`
);
console.log(
  `[whatif-maker] adverseBps=${adverseBps} adverseK=${adverseK} by=${bySpread ? "spread" : "net_edge"}`
);
console.log("");

summarize("OVERALL", rows);
for (const b of buckets) {
  summarize(b, rows.filter((r) => r[bucketKey] === b));
}

sqlite.close();
