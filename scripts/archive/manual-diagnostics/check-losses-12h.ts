#!/usr/bin/env npx tsx
/**
 * 12h loss investigation: pulls fills, derives mid-at-fill + markout PnL proxy,
 * and summarizes maker/taker quality (spread/staleness at fill time).
 *
 * Usage:
 *   npx tsx scripts/archive/manual-diagnostics/check-losses-12h.ts
 *   npx tsx scripts/archive/manual-diagnostics/check-losses-12h.ts --hours=12 --db=data/dev.db --horizons=5000,30000
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../../packages/storage/src/index.js";

type FillRow = {
  id: number;
  ts: number;
  price: number | null;
  size: number | null;
  side: "BUY" | "SELL";
  kind: string;
  walletId: number | null;
  tokenId: string;
};

type FeatureRow = {
  mid: number | null;
  spread: number | null;
  stalenessSec: number | null;
  bestBid: number | null;
  bestAsk: number | null;
};

type Agg = {
  count: number;
  win: number;
  loss: number;
  sumBps: number;
  sumNotional: number;
  sumPnl: number;
  sumSpread: number;
  sumStaleness: number;
  spreadCount: number;
  stalenessCount: number;
};

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
const hours = Math.max(1, Number(args.get("hours") ?? 12));
const horizons = (args.get("horizons") ?? "5000,30000")
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

const makerKinds = new Set(["MAKER_BID", "MAKER_ASK", "INVENTORY_REBALANCE"]);
const takerKinds = new Set(["TAKER_BUY", "TAKER_SELL"]);

const fills = sqlite
  .prepare(
    `SELECT
       f.id as id,
       f.ts as ts,
       f.price as price,
       f.size as size,
       o.side as side,
       o.kind as kind,
       o.wallet_id as walletId,
       o.token_id as tokenId
     FROM shadow_fills f
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE f.ts >= ?
       AND f.method != 'synthetic_fill'
     ORDER BY f.id ASC`
  )
  .all(since) as FillRow[];

const featureAtOrBeforeStmt = sqlite.prepare(
  `SELECT mid, spread, staleness_sec as stalenessSec, best_bid as bestBid, best_ask as bestAsk
   FROM features
   WHERE token_id = ? AND ts <= ? AND mid IS NOT NULL
   ORDER BY ts DESC
   LIMIT 1`
);
const featureAtOrAfterStmt = sqlite.prepare(
  `SELECT mid
   FROM features
   WHERE token_id = ? AND ts >= ? AND mid IS NOT NULL
   ORDER BY ts ASC
   LIMIT 1`
);

const aggInit = (): Agg => ({
  count: 0,
  win: 0,
  loss: 0,
  sumBps: 0,
  sumNotional: 0,
  sumPnl: 0,
  sumSpread: 0,
  sumStaleness: 0,
  spreadCount: 0,
  stalenessCount: 0
});

const formatNumber = (value: number | null, digits = 2): string => {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
};

const aggAdd = (agg: Agg, markoutBps: number, notional: number): void => {
  agg.count += 1;
  agg.sumBps += markoutBps;
  agg.sumNotional += notional;
  const pnl = (markoutBps / 10_000) * notional;
  agg.sumPnl += pnl;
  if (markoutBps >= 0) agg.win += 1;
  else agg.loss += 1;
};

const aggAddQuality = (agg: Agg, feature: FeatureRow): void => {
  if (Number.isFinite(feature.spread)) {
    agg.sumSpread += feature.spread as number;
    agg.spreadCount += 1;
  }
  if (Number.isFinite(feature.stalenessSec)) {
    agg.sumStaleness += feature.stalenessSec as number;
    agg.stalenessCount += 1;
  }
};

const computeMarkoutBps = (
  side: "BUY" | "SELL",
  midAtFill: number,
  midAtHorizon: number
): number => {
  if (side === "BUY") {
    return ((midAtHorizon - midAtFill) / midAtFill) * 10_000;
  }
  return ((midAtFill - midAtHorizon) / midAtFill) * 10_000;
};

const summarizeAgg = (label: string, agg: Agg): void => {
  const avgBps = agg.count > 0 ? agg.sumBps / agg.count : null;
  const wAvgBps = agg.sumNotional > 0 ? (agg.sumPnl / agg.sumNotional) * 10_000 : null;
  const winRate = agg.count > 0 ? (agg.win / agg.count) * 100 : null;
  const avgSpread = agg.spreadCount > 0 ? agg.sumSpread / agg.spreadCount : null;
  const avgStale = agg.stalenessCount > 0 ? agg.sumStaleness / agg.stalenessCount : null;
  console.log(
    `  ${label}: n=${agg.count} avg=${formatNumber(avgBps)}bps wavg=${formatNumber(wAvgBps)}bps ` +
      `win_rate=${formatNumber(winRate)}% notional=$${formatNumber(agg.sumNotional, 0)} pnl=$${formatNumber(agg.sumPnl, 2)}`
  );
  console.log(
    `    quality: avg_spread=${formatNumber(avgSpread, 4)} avg_staleness=${formatNumber(avgStale, 2)}s`
  );
};

const percentile = (xs: number[], p: number): number => {
  if (!xs.length || p < 0 || p > 1) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const i = p * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (i - lo) * (sorted[hi]! - sorted[lo]!);
};

const slippageBpsBySide = new Map<"BUY" | "SELL", number[]>();
const midVsFillBpsBySide = new Map<"BUY" | "SELL", number[]>();
for (const fill of fills) {
  if (!takerKinds.has(fill.kind)) continue;
  if (!Number.isFinite(fill.price) || !Number.isFinite(fill.size) || (fill.size ?? 0) <= 0) continue;
  const feat = featureAtOrBeforeStmt.get(fill.tokenId, fill.ts) as FeatureRow | undefined;
  if (!feat?.mid || !Number.isFinite(feat.mid) || feat.mid <= 0) continue;
  const side = fill.side === "BUY" || fill.side === "SELL" ? fill.side : "BUY";
  const touchPrice = side === "BUY" ? feat.bestAsk : feat.bestBid;
  if (touchPrice != null && Number.isFinite(touchPrice) && touchPrice > 0) {
    const dir = side === "BUY" ? (fill.price as number) - touchPrice : touchPrice - (fill.price as number);
    const bps = (dir / touchPrice) * 10_000;
    const arr = slippageBpsBySide.get(side) ?? [];
    arr.push(bps);
    slippageBpsBySide.set(side, arr);
  }
  const dir2 = side === "BUY" ? (fill.price as number) - feat.mid : feat.mid - (fill.price as number);
  const midBps = (dir2 / feat.mid) * 10_000;
  const arr2 = midVsFillBpsBySide.get(side) ?? [];
  arr2.push(midBps);
  midVsFillBpsBySide.set(side, arr2);
}

console.log(`[loss-12h] DB: ${dbPath}`);
console.log(`[loss-12h] window: last ${hours}h`);
console.log(`[loss-12h] fills: ${fills.length}`);

if (slippageBpsBySide.size > 0 || midVsFillBpsBySide.size > 0) {
  console.log(`[loss-12h] slippage vs touch (taker):`);
  for (const side of ["BUY", "SELL"] as const) {
    const sl = slippageBpsBySide.get(side) ?? [];
    const mf = midVsFillBpsBySide.get(side) ?? [];
    if (sl.length > 0 || mf.length > 0) {
      const slMean = sl.length > 0 ? sl.reduce((a, b) => a + b, 0) / sl.length : null;
      const slMed = sl.length > 0 ? percentile(sl, 0.5) : null;
      const mfMean = mf.length > 0 ? mf.reduce((a, b) => a + b, 0) / mf.length : null;
      const mfMed = mf.length > 0 ? percentile(mf, 0.5) : null;
      console.log(
        `  ${side}: slippage_bps mean=${formatNumber(slMean)} median=${formatNumber(slMed)} n=${sl.length} | mid_vs_fill_bps mean=${formatNumber(mfMean)} median=${formatNumber(mfMed)} n=${mf.length}`
      );
    }
  }
  console.log("");
}

for (const horizonMs of horizons) {
  const makerAgg = aggInit();
  const takerAgg = aggInit();
  const takerBySide = new Map<"BUY" | "SELL", number[]>();
  const perWallet = new Map<string, Agg>();

  for (const fill of fills) {
    if (!Number.isFinite(fill.size) || (fill.size ?? 0) <= 0) continue;
    const feature = featureAtOrBeforeStmt.get(fill.tokenId, fill.ts) as FeatureRow | undefined;
    if (!feature || !Number.isFinite(feature.mid) || (feature.mid ?? 0) <= 0) continue;
    const midAtFill = feature.mid as number;
    const notional = (fill.size as number) * midAtFill;
    if (!Number.isFinite(notional) || notional <= 0) continue;

    const after = featureAtOrAfterStmt.get(fill.tokenId, fill.ts + horizonMs) as { mid: number } | undefined;
    if (!after || !Number.isFinite(after.mid) || after.mid <= 0) continue;
    const markoutBps = computeMarkoutBps(fill.side, midAtFill, after.mid);

    const isMaker = makerKinds.has(fill.kind);
    const isTaker = takerKinds.has(fill.kind);
    if (!isMaker && !isTaker) continue;

    const agg = isMaker ? makerAgg : takerAgg;
    aggAdd(agg, markoutBps, notional);
    aggAddQuality(agg, feature);

    if (isTaker) {
      const side = fill.side === "BUY" || fill.side === "SELL" ? fill.side : "BUY";
      const arr = takerBySide.get(side) ?? [];
      arr.push(markoutBps);
      takerBySide.set(side, arr);
    }

    const walletKey = `${fill.walletId ?? -1}:${isMaker ? "maker" : "taker"}`;
    const walletAgg = perWallet.get(walletKey) ?? aggInit();
    aggAdd(walletAgg, markoutBps, notional);
    aggAddQuality(walletAgg, feature);
    perWallet.set(walletKey, walletAgg);
  }

  console.log(`[loss-12h] horizon ${horizonMs}ms markout PnL proxy:`);
  summarizeAgg("maker", makerAgg);
  summarizeAgg("taker", takerAgg);
  if (takerBySide.size > 0) {
    const parts: string[] = [];
    for (const [side, vals] of takerBySide) {
      if (vals.length > 0) {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        parts.push(`taker ${side} mean=${formatNumber(mean)}bps n=${vals.length}`);
      }
    }
    if (parts.length > 0) console.log(`  adverse-selection cue: ${parts.join(" | ")}`);
  }

  const worst = Array.from(perWallet.entries())
    .map(([key, agg]) => ({ key, agg }))
    .filter((entry) => entry.agg.count > 0)
    .sort((a, b) => a.agg.sumPnl - b.agg.sumPnl)
    .slice(0, 5);

  if (worst.length > 0) {
    console.log("  worst wallets:");
    for (const entry of worst) {
      const [walletId, mode] = entry.key.split(":");
      const wAvg = entry.agg.sumNotional > 0 ? (entry.agg.sumPnl / entry.agg.sumNotional) * 10_000 : null;
      console.log(
        `  wallet ${walletId} ${mode}: pnl=$${formatNumber(entry.agg.sumPnl, 2)} ` +
          `fills=${entry.agg.count} wavg=${formatNumber(wAvg)}bps`
      );
    }
  }
}

sqlite.close();
