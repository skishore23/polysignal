#!/usr/bin/env npx tsx
/**
 * Empirical pFill and time-to-fill from shadow taker flow.
 * For each "maker post moment" (feature snapshot), find time until next opposite-side taker fill.
 * Maker BUY gets filled when taker SELL hits bid → time to next taker SELL.
 * Maker SELL gets filled when taker BUY hits ask → time to next taker BUY.
 *
 * Outputs: P(fill within 1m, 5m, 10m, 20m, 40m), median and p90 time-to-fill, noFill% within max window, by spread bucket.
 *
 * Usage:
 *   npx tsx scripts/archive/manual-diagnostics/empirical-pfill-time-to-fill.ts --hours=24
 *   npx tsx scripts/archive/manual-diagnostics/empirical-pfill-time-to-fill.ts --hours=24 --sample=60  # one row per token per 60s
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../../packages/storage/src/index.js";

type Side = "BUY" | "SELL";

function bucketSpread(rtSpreadBps: number): string {
  if (!Number.isFinite(rtSpreadBps) || rtSpreadBps < 0) return "unknown";
  if (rtSpreadBps <= 10) return "0-10";
  if (rtSpreadBps <= 25) return "10-25";
  if (rtSpreadBps <= 50) return "25-50";
  if (rtSpreadBps <= 100) return "50-100";
  if (rtSpreadBps <= 200) return "100-200";
  return "200+";
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const ys = [...xs].sort((a, b) => a - b);
  const m = Math.floor(ys.length / 2);
  return ys.length % 2 ? ys[m]! : (ys[m - 1]! + ys[m]!) / 2;
}

function p90(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const finite = xs.filter((x) => Number.isFinite(x));
  if (finite.length === 0) return NaN;
  const ys = [...finite].sort((a, b) => a - b);
  const idx = Math.ceil(0.9 * ys.length) - 1;
  return ys[Math.max(0, idx)] ?? NaN;
}

function pctWithin(xs: number[], thresholdMs: number): number {
  if (xs.length === 0) return 0;
  const k = xs.filter((x) => x <= thresholdMs && x >= 0).length;
  return (k / xs.length) * 100;
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
const args = parseArgs();
const dbRaw = args.get("db") ?? "data/dev.db";
const dbPath = path.isAbsolute(dbRaw) ? dbRaw : path.join(__dirname, "..", dbRaw);
const hours = Math.max(1, Number(args.get("hours") ?? 24));
const sampleEvery = Math.max(1, Number(args.get("sample") ?? 60));

const sinceTs = Date.now() - hours * 60 * 60 * 1000;

const { sqlite } = openDatabase(dbPath);

type FillRow = { ts: number; token_id: string; side: Side };
const fills = sqlite
  .prepare(
    `SELECT f.ts as ts, o.token_id as token_id, o.side as side
     FROM shadow_fills f
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE f.ts >= ?
       AND f.method != 'synthetic_fill'
       AND o.kind IN ('TAKER_BUY','TAKER_SELL')
       AND o.execution_mode = 'SHADOW'`
  )
  .all(sinceTs) as FillRow[];

type FeatureRow = { ts: number; token_id: string; spread: number | null; mid: number | null };
const features = sqlite
  .prepare(
    `SELECT ts, token_id, spread, mid FROM features
     WHERE ts >= ? AND mid IS NOT NULL AND mid > 0
     ORDER BY token_id, ts`
  )
  .all(sinceTs) as FeatureRow[];

const fillsByToken = new Map<string, { ts: number; side: Side }[]>();
for (const f of fills) {
  const arr = fillsByToken.get(f.token_id) ?? [];
  arr.push({ ts: f.ts, side: f.side });
  fillsByToken.set(f.token_id, arr);
}
for (const arr of fillsByToken.values()) {
  arr.sort((a, b) => a.ts - b.ts);
}

function nextFillTs(tokenId: string, afterTs: number, side: Side): number | null {
  const arr = fillsByToken.get(tokenId);
  if (!arr) return null;
  const hit = arr.find((x) => x.ts > afterTs && x.side === side);
  return hit?.ts ?? null;
}

const HORIZONS_MS = [60_000, 300_000, 600_000, 1_200_000, 2_400_000] as const; // 1m, 5m, 10m, 20m, 40m
const MAX_WINDOW_MS = 2_400_000; // 40m

type Sample = {
  spreadBucket: string;
  ttFillBuyMs: number | null;
  ttFillSellMs: number | null;
};

const samples: Sample[] = [];
let lastTsByToken = new Map<string, number>();

for (const row of features) {
  const tokenId = row.token_id;
  const lastTs = lastTsByToken.get(tokenId) ?? 0;
  if (row.ts - lastTs < sampleEvery * 1000) continue;
  lastTsByToken.set(tokenId, row.ts);

  const spreadBps =
    row.spread != null && row.mid != null && row.mid > 0
      ? (row.spread / row.mid) * 10_000
      : 0;
  const bucket = bucketSpread(spreadBps);

  const nextBuy = nextFillTs(tokenId, row.ts, "BUY");
  const nextSell = nextFillTs(tokenId, row.ts, "SELL");

  samples.push({
    spreadBucket: bucket,
    ttFillBuyMs: nextBuy != null ? nextBuy - row.ts : Number.POSITIVE_INFINITY,
    ttFillSellMs: nextSell != null ? nextSell - row.ts : Number.POSITIVE_INFINITY
  });
}

const spreadOrder = ["0-10", "10-25", "25-50", "50-100", "100-200", "200+", "unknown"];
const buckets = Array.from(new Set(samples.map((s) => s.spreadBucket))).sort(
  (a, b) => spreadOrder.indexOf(a) - spreadOrder.indexOf(b)
);

function summarize(label: string, ss: Sample[]): void {
  const buyTt = ss.map((s) => s.ttFillBuyMs);
  const sellTt = ss.map((s) => s.ttFillSellMs);
  const allTt = [...buyTt, ...sellTt];
  const finiteTt = allTt.filter((x) => Number.isFinite(x));

  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "—");
  const fmtPct = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "—");

  const pFillParts = HORIZONS_MS.map(
    (h) => `pFill_${h === 60_000 ? "1m" : h === 300_000 ? "5m" : h === 600_000 ? "10m" : h === 1_200_000 ? "20m" : "40m"}=${fmtPct(pctWithin(allTt, h))}%`
  ).join(" ");
  const noFillPct = ((allTt.length - finiteTt.length) / Math.max(1, allTt.length)) * 100;
  const medSec = median(finiteTt) / 1000;
  const p90Sec = p90(finiteTt) / 1000;

  const line = [
    label.padEnd(10),
    `n=${ss.length.toString().padStart(5)}`,
    pFillParts,
    `med_ttFill_s=${fmt(medSec)} p90_ttFill_s=${fmt(p90Sec)} noFill_pct=${fmtPct(noFillPct)}%`
  ].join(" | ");
  console.log(line);
}

console.log(`[empirical-pfill] DB: ${dbPath}`);
console.log(`[empirical-pfill] Window: last ${hours}h | sample every ${sampleEvery}s`);
console.log(`[empirical-pfill] Taker fills: ${fills.length} | Feature samples: ${samples.length}`);
console.log(`[empirical-pfill] Logic: time from feature snapshot to next opposite-side taker fill`);
console.log("");

summarize("OVERALL", samples);
for (const b of buckets) {
  summarize(b, samples.filter((s) => s.spreadBucket === b));
}

sqlite.close();
