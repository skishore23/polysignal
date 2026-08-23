#!/usr/bin/env npx tsx
/**
 * Counterfactual gate validator (pre-live).
 *
 * Goal: test whether stricter edge thresholds would have improved realized markouts
 * without collapsing trade count.
 *
 * Usage:
 *   npx tsx scripts/validate-counterfactual-gate.ts
 *   npx tsx scripts/validate-counterfactual-gate.ts --hours=72 --horizon-ms=30000 --thresholds=0,10,25,50
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../packages/storage/src/index.js";

type Row = {
  orderId: number;
  ts: number;
  kind: string;
  walletId: number | null;
  netEdgeBps: number | null;
  markoutBps: number | null;
  price: number | null;
  size: number | null;
};

type Metrics = {
  count: number;
  winRate: number;
  avgBps: number;
  wavgBps: number;
  notional: number;
};

type SweepRow = {
  threshold: number;
  metrics: Metrics;
  coverage: number;
  upliftAvgBps: number;
  upliftWavgBps: number;
  pass: boolean;
  failReasons: string[];
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

const fmtPct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const fmtBps = (v: number): string => `${v.toFixed(2)} bps`;

const computeMetrics = (rows: Row[]): Metrics => {
  if (!rows.length) {
    return { count: 0, winRate: 0, avgBps: 0, wavgBps: 0, notional: 0 };
  }
  let wins = 0;
  let sumBps = 0;
  let sumW = 0;
  let sumWBps = 0;
  for (const row of rows) {
    const bps = row.markoutBps as number;
    const px = row.price as number;
    const sz = row.size as number;
    const notional = px * sz;
    if (bps >= 0) wins += 1;
    sumBps += bps;
    if (Number.isFinite(notional) && notional > 0) {
      sumW += notional;
      sumWBps += bps * notional;
    }
  }
  return {
    count: rows.length,
    winRate: wins / rows.length,
    avgBps: sumBps / rows.length,
    wavgBps: sumW > 0 ? sumWBps / sumW : 0,
    notional: sumW
  };
};

const args = parseArgs();
const hours = Math.max(1, Number(args.get("hours") ?? 72));
const horizonMs = Math.max(1000, Number(args.get("horizon-ms") ?? 30_000));
const minSamples = Math.max(1, Number(args.get("min-samples") ?? 50));
const minCoverage = Math.max(0, Math.min(1, Number(args.get("min-coverage") ?? 0.25)));
const minUpliftBps = Number(args.get("min-uplift-bps") ?? 10);
const minAvgBps = Number(args.get("min-avg-bps") ?? 0);
const thresholdList = (args.get("thresholds") ?? "0,5,10,15,25,35,50,75,100")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x))
  .map((x) => Math.max(0, x))
  .sort((a, b) => a - b);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dbRaw = args.get("db") ?? "data/dev.db";
const dbPath = path.isAbsolute(dbRaw) ? dbRaw : path.join(repoRoot, dbRaw);

const kinds = ["TAKER_BUY", "TAKER_SELL"];

const placeholders = kinds.map(() => "?").join(",");
const sinceTs = Date.now() - hours * 3600 * 1000;

const { sqlite } = openDatabase(dbPath);
const rows = sqlite
  .prepare(
    `SELECT
      o.id as orderId,
      o.ts as ts,
      o.kind as kind,
      o.wallet_id as walletId,
      o.net_edge_bps as netEdgeBps,
      m.markout_bps as markoutBps,
      f.price as price,
      f.size as size
     FROM shadow_orders o
     JOIN shadow_fills f ON f.order_id = o.id
     JOIN shadow_markouts m ON m.fill_id = f.id
     WHERE o.execution_mode = 'SHADOW'
       AND o.ts >= ?
       AND m.horizon_ms = ?
       AND o.kind IN (${placeholders})
     ORDER BY o.ts ASC`
  )
  .all(sinceTs, horizonMs, ...kinds) as Row[];
sqlite.close();

const clean = rows.filter((row) => {
  if (!Number.isFinite(row.markoutBps ?? NaN)) return false;
  if (!Number.isFinite(row.price ?? NaN) || (row.price ?? 0) <= 0) return false;
  if (!Number.isFinite(row.size ?? NaN) || (row.size ?? 0) <= 0) return false;
  return true;
});

const withEdge = clean.filter((row) => Number.isFinite(row.netEdgeBps ?? NaN));
const baseline = computeMetrics(clean);

const sweep: SweepRow[] = thresholdList.map((threshold) => {
  const selected = withEdge.filter((row) => (row.netEdgeBps as number) >= threshold);
  const m = computeMetrics(selected);
  const coverage = baseline.count > 0 ? m.count / baseline.count : 0;
  const upliftAvgBps = m.avgBps - baseline.avgBps;
  const upliftWavgBps = m.wavgBps - baseline.wavgBps;
  const failReasons: string[] = [];
  if (m.count < minSamples) failReasons.push(`count_lt_${minSamples}`);
  if (coverage < minCoverage) failReasons.push(`coverage_lt_${minCoverage}`);
  if (m.avgBps < minAvgBps) failReasons.push(`avg_lt_${minAvgBps}`);
  if (upliftAvgBps < minUpliftBps) failReasons.push(`uplift_lt_${minUpliftBps}`);
  return {
    threshold,
    metrics: m,
    coverage,
    upliftAvgBps,
    upliftWavgBps,
    pass: failReasons.length === 0,
    failReasons
  };
});

const winners = sweep.filter((x) => x.pass).sort((a, b) => b.metrics.avgBps - a.metrics.avgBps);
const best = winners[0] ?? null;

console.log(`[counterfactual] DB: ${dbPath}`);
console.log(
  `[counterfactual] window: last ${hours}h (since ${new Date(sinceTs).toISOString()}) | horizon=${horizonMs}ms`
);
console.log(`[counterfactual] kinds: ${kinds.join(", ")}`);
console.log(
  `[counterfactual] criteria: minSamples=${minSamples} minCoverage=${minCoverage} minAvgBps=${minAvgBps} minUpliftBps=${minUpliftBps}`
);
console.log("");
console.log(
  `[counterfactual] baseline: n=${baseline.count} win=${fmtPct(baseline.winRate)} avg=${fmtBps(
    baseline.avgBps
  )} wavg=${fmtBps(baseline.wavgBps)}`
);
console.log(
  `[counterfactual] with finite net_edge_bps: ${withEdge.length}/${clean.length} (${fmtPct(
    clean.length > 0 ? withEdge.length / clean.length : 0
  )})`
);
console.log("");
console.log("threshold  n     cov    avg_bps   wavg_bps  uplift_avg  pass  reason");
for (const row of sweep) {
  const reason = row.pass ? "ok" : row.failReasons.join("|");
  console.log(
    `${row.threshold.toString().padStart(9)}  ${row.metrics.count
      .toString()
      .padStart(4)}  ${fmtPct(row.coverage).padStart(6)}  ${fmtBps(row.metrics.avgBps).padStart(
      8
    )}  ${fmtBps(row.metrics.wavgBps).padStart(8)}  ${fmtBps(row.upliftAvgBps).padStart(
      9
    )}  ${row.pass ? "YES " : "NO  "}  ${reason}`
  );
}

if (!clean.length) {
  console.log("\nNO-GO: no eligible rows for this window/horizon.");
  process.exit(1);
}

if (!best) {
  console.log("\nNO-GO: no threshold satisfies criteria.");
  process.exit(1);
}

console.log(
  `\nGO: threshold=${best.threshold} | n=${best.metrics.count} | avg=${fmtBps(
    best.metrics.avgBps
  )} | uplift=${fmtBps(best.upliftAvgBps)} | coverage=${fmtPct(best.coverage)}`
);
