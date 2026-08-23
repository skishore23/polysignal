#!/usr/bin/env npx tsx
/**
 * What-if exit: assume every taker round-trip exits at +5m and +10m.
 * Compares actual realized vs what-if to answer "is taker salvageable?"
 *
 * Usage:
 *   npx tsx scripts/archive/manual-diagnostics/whatif-exit.ts --hours=24
 *   npx tsx scripts/archive/manual-diagnostics/whatif-exit.ts --db=./data/dev.db --hours=24 --includeOpen=true
 *   npx tsx scripts/archive/manual-diagnostics/whatif-exit.ts --hours=24 --costMult=0      # zero cost (alpha-only)
 *   npx tsx scripts/archive/manual-diagnostics/whatif-exit.ts --hours=24 --sweep           # costMult 0, 0.25, 0.5, 1.0, 2.0
 *   npx tsx scripts/archive/manual-diagnostics/whatif-exit.ts --hours=24 --fillModel=mid   # alpha-only
 *   npx tsx scripts/archive/manual-diagnostics/whatif-exit.ts --hours=24 --fillModel=touch # spread+fees, no slippage
 *   npx tsx scripts/archive/manual-diagnostics/whatif-exit.ts --hours=24 --fillModel=touch+slip # full (default)
 *   npx tsx scripts/archive/manual-diagnostics/whatif-exit.ts --hours=24 --by=spread # bucket by rt_spread instead of net_edge
 *   npx tsx scripts/archive/manual-diagnostics/whatif-exit.ts --hours=24 --spreadCheck # verify spread_bps = (ask-bid)/mid*1e4 then exit
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
  cost_bps: number | null;
  spread_bps: number | null;
  fees_bps: number | null;
  expected_slippage_bps: number | null;
};

type CostComponents = {
  spread_bps: number;
  fees_bps: number;
  slippage_bps: number;
};

type Trade = {
  wallet_id: string;
  token_id: string;
  dir: 1 | -1;
  open_ts: number;
  close_ts: number | null;
  entry_net_edge_bps: number | null;
  open_cost_bps: number | null;
  close_cost_bps: number | null;
  open_spread_bps: number | null;
  open_fees_bps: number | null;
  open_slippage_bps: number | null;
  close_spread_bps: number | null;
  close_fees_bps: number | null;
  close_slippage_bps: number | null;
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

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const ys = [...xs].sort((a, b) => a - b);
  const m = Math.floor(ys.length / 2);
  return ys.length % 2 ? ys[m]! : (ys[m - 1]! + ys[m]!) / 2;
}

function pctFinite(xs: Array<number | null | undefined>): number {
  const n = xs.length;
  const k = xs.filter((x) => x != null && Number.isFinite(x)).length;
  return n === 0 ? 0 : (k / n) * 100;
}

function makeKey(walletId: number | null, tokenId: string): string {
  return `${walletId ?? -1}::${tokenId}`;
}

type FillModel = "mid" | "touch" | "touch+slip";
function effectiveCost(rt: CostComponents, fillModel: FillModel): number {
  if (fillModel === "mid") return 0;
  if (fillModel === "touch") return rt.spread_bps + rt.fees_bps;
  return rt.spread_bps + rt.fees_bps + rt.slippage_bps;
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
const costMult = Number(args.get("costMult") ?? 1);
const sweep = args.get("sweep") === "true";
const fillModelRaw = args.get("fillModel") ?? "touch+slip";
const fillModel: FillModel =
  fillModelRaw === "mid" ? "mid" : fillModelRaw === "touch" ? "touch" : "touch+slip";
const bySpread = args.get("by") === "spread";
const spreadCheck = args.get("spreadCheck") === "true";

const sinceTs = Date.now() - hours * 60 * 60 * 1000;

const { sqlite } = openDatabase(dbPath);

if (spreadCheck) {
  const check = sqlite
    .prepare(
      `SELECT spread, mid, best_bid, best_ask FROM features
       WHERE ts >= ? AND mid IS NOT NULL AND mid > 0 AND spread IS NOT NULL
       LIMIT 50000`
    )
    .all(sinceTs) as Array<{
    spread: number | null;
    mid: number | null;
    best_bid: number | null;
    best_ask: number | null;
  }>;

  const rawSpread = check
    .filter((r) => r.best_ask != null && r.best_bid != null)
    .map((r) => (r.best_ask! - r.best_bid!));
  const spreadFromCol = check
    .filter((r) => r.spread != null && r.mid != null && r.mid > 0)
    .map((r) => r.spread!);
  const spreadBpsFromCol = check
    .filter((r) => r.spread != null && r.mid != null && r.mid > 0)
    .map((r) => (r.spread! / r.mid!) * 10_000);
  const spreadBpsFromBook = check
    .filter(
      (r) =>
        r.best_ask != null &&
        r.best_bid != null &&
        r.mid != null &&
        r.mid > 0
    )
    .map((r) => ((r.best_ask! - r.best_bid!) / r.mid!) * 10_000);

  console.log("[whatif-exit] spread sanity check:");
  console.log(
    `  median(best_ask - best_bid) raw = ${median(rawSpread).toFixed(6)}`
  );
  const mids = check.filter((r) => r.mid != null && r.mid > 0).map((r) => r.mid!);
  console.log(`  median(mid) = ${median(mids).toFixed(6)}`);
  console.log(
    `  median(spread col) = ${median(spreadFromCol).toFixed(6)}`
  );
  console.log(
    `  spread_bps from (spread/mid)*1e4: median=${median(spreadBpsFromCol).toFixed(2)}`
  );
  console.log(
    `  spread_bps from (ask-bid)/mid*1e4: median=${median(spreadBpsFromBook).toFixed(2)}`
  );
  const diff =
    Math.abs(median(spreadBpsFromCol) - median(spreadBpsFromBook)) || 0;
  console.log(
    diff < 1
      ? "  OK: spread_bps formula consistent"
      : `  WARN: spread_bps diff=${diff.toFixed(2)} (check units)`
  );
  sqlite.close();
  process.exit(0);
}

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
       o.cost_bps as cost_bps,
       o.spread_bps as spread_bps,
       o.fees_bps as fees_bps,
       o.expected_slippage_bps as expected_slippage_bps
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
      closeCostBps: number | null,
      closeSpread: number | null,
      closeFees: number | null,
      closeSlip: number | null
    ) => {
    if (st.trade) {
      st.trade.close_ts = closeTs;
      st.trade.close_cost_bps = closeCostBps;
      st.trade.close_spread_bps = closeSpread;
      st.trade.close_fees_bps = closeFees;
      st.trade.close_slippage_bps = closeSlip;
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
      open_cost_bps: f.cost_bps,
      close_cost_bps: null,
      open_spread_bps: f.spread_bps,
      open_fees_bps: f.fees_bps,
      open_slippage_bps: f.expected_slippage_bps,
      close_spread_bps: null,
      close_fees_bps: null,
      close_slippage_bps: null
    };
  }

  if (prevQty !== 0 && nextQty !== 0 && Math.sign(prevQty) !== Math.sign(nextQty)) {
    closeTrade(f.ts, f.cost_bps, f.spread_bps, f.fees_bps, f.expected_slippage_bps);
    st.trade = {
      wallet_id: String(f.wallet_id ?? -1),
      token_id: f.token_id,
      dir: nextQty > 0 ? 1 : -1,
      open_ts: f.ts,
      close_ts: null,
      entry_net_edge_bps: f.net_edge_bps,
      open_cost_bps: f.cost_bps,
      close_cost_bps: null,
      open_spread_bps: f.spread_bps,
      open_fees_bps: f.fees_bps,
      open_slippage_bps: f.expected_slippage_bps,
      close_spread_bps: null,
      close_fees_bps: null,
      close_slippage_bps: null
    };
  }

  if (prevQty !== 0 && nextQty === 0) {
    closeTrade(f.ts, f.cost_bps, f.spread_bps, f.fees_bps, f.expected_slippage_bps);
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
  rt_cost_bps: number;
  rt_spread_bps: number;
  rt_fees_bps: number;
  rt_slippage_bps: number;
  actual_gross_bps: number | null;
  w5_gross_bps: number | null;
  w10_gross_bps: number | null;
};

const rows: RowOut[] = [];
for (const t of trades) {
  const entryMid = getMid(t.token_id, t.open_ts);
  if (entryMid == null) continue;

  const oSpread = t.open_spread_bps ?? 0;
  const oFees = t.open_fees_bps ?? 0;
  const oSlip = t.open_slippage_bps ?? 0;
  const cSpread = t.close_spread_bps ?? t.open_spread_bps ?? 0;
  const cFees = t.close_fees_bps ?? t.open_fees_bps ?? 0;
  const cSlip = t.close_slippage_bps ?? t.open_slippage_bps ?? 0;

  const rtCost =
    (t.open_cost_bps ?? 0) + (t.close_cost_bps ?? t.open_cost_bps ?? 0);
  const rtSpread = oSpread + cSpread;
  const rtFees = oFees + cFees;
  const rtSlip = oSlip + cSlip;

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
    rt_cost_bps: rtCost,
    rt_spread_bps: rtSpread,
    rt_fees_bps: rtFees,
    rt_slippage_bps: rtSlip,
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

function summarize(
  label: string,
  rs: RowOut[],
  costMultVal: number,
  fillModelVal: FillModel
): void {
  const effCost = (r: RowOut) =>
    effectiveCost(
      {
        spread_bps: r.rt_spread_bps,
        fees_bps: r.rt_fees_bps,
        slippage_bps: r.rt_slippage_bps
      },
      fillModelVal
    ) * costMultVal;

  const actualPairs = rs
    .filter((r) => r.actual_gross_bps != null)
    .map((r) => ({ gross: r.actual_gross_bps!, cost: effCost(r) }));
  const actualNet = actualPairs.map((p) => p.gross - p.cost);

  const w5Pairs = rs
    .filter((r) => r.w5_gross_bps != null)
    .map((r) => ({ gross: r.w5_gross_bps!, cost: effCost(r) }));
  const w10Pairs = rs
    .filter((r) => r.w10_gross_bps != null)
    .map((r) => ({ gross: r.w10_gross_bps!, cost: effCost(r) }));

  const rtSpread = rs.map((r) => r.rt_spread_bps);
  const rtFees = rs.map((r) => r.rt_fees_bps);
  const rtSlip = rs.map((r) => r.rt_slippage_bps);
  const rtCosts = rs.map((r) => r.rt_cost_bps);

  const w5Gross = w5Pairs.map((p) => p.gross);
  const w10Gross = w10Pairs.map((p) => p.gross);
  const w5Net = w5Pairs.map((p) => p.gross - p.cost);
  const w10Net = w10Pairs.map((p) => p.gross - p.cost);

  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "—");
  const line = [
    label.padEnd(10),
    `n=${rs.length.toString().padStart(5)}`,
    `w5_gross=${fmt(mean(w5Gross))} rt_cost=${fmt(mean(rtCosts))} (spread=${fmt(mean(rtSpread))} fees=${fmt(mean(rtFees))} slip=${fmt(mean(rtSlip))}) w5_net=${fmt(mean(w5Net))}`,
    `w10_gross=${fmt(mean(w10Gross))} w10_net=${fmt(mean(w10Net))} | actual_net mean=${fmt(mean(actualNet))} cov=${pctFinite(rs.map((r) => r.actual_gross_bps)).toFixed(1)}%`
  ].join(" | ");
  console.log(line);
}

const costMults = sweep ? [0, 0.25, 0.5, 1, 2] : [costMult];

for (const mult of costMults) {
  if (sweep) {
    console.log(`\n[whatif-exit] costMult=${mult}`);
  }
  if (!sweep || mult === costMults[0]) {
    console.log(`[whatif-exit] DB: ${dbPath}`);
    console.log(`[whatif-exit] Window: last ${hours}h | sinceTs=${sinceTs}`);
    console.log(`[whatif-exit] Horizons: 5m=${horizon5m}ms, 10m=${horizon10m}ms`);
    console.log(`[whatif-exit] Trades: ${trades.length} (includeOpen=${includeOpen})`);
    if (!sweep)
      console.log(
        `[whatif-exit] costMult=${mult} fillModel=${fillModel} by=${bySpread ? "spread" : "net_edge"}`
      );
    console.log("");
  }

  summarize("OVERALL", rows, mult, fillModel);
  for (const b of buckets) {
    summarize(b, rows.filter((r) => r[bucketKey] === b), mult, fillModel);
  }
}

sqlite.close();
