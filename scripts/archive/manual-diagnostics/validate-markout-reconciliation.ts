#!/usr/bin/env npx tsx
/**
 * Markout reconciliation: confirm stored markouts match recomputed values.
 * Arithmetic check (from stored mids) + features check (from features table).
 *
 * Usage:
 *   npx tsx scripts/archive/manual-diagnostics/validate-markout-reconciliation.ts --hours=24
 *   npx tsx scripts/archive/manual-diagnostics/validate-markout-reconciliation.ts --db=data/dev.db --horizonMs=300000 --sample=5 --verbose
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../../packages/storage/src/index.js";

const TOLERANCE_ARITHMETIC_BPS = 0.1;
const TOLERANCE_FEATURES_BPS = 5;

function computeMarkoutBps(side: "BUY" | "SELL", midAtFill: number, midAtHorizon: number): number {
  const pnl =
    side === "BUY"
      ? (midAtHorizon - midAtFill) / midAtFill
      : (midAtFill - midAtHorizon) / midAtFill;
  return pnl * 10_000;
}

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

type Row = {
  fillId: number;
  fillTs: number;
  tokenId: string;
  side: "BUY" | "SELL";
  midAtFill: number | null;
  midAtHorizon: number | null;
  markoutBps: number | null;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const args = parseArgs();
const hours = Math.max(1, Number(args.get("hours") ?? 24));
const horizonMs = Number(args.get("horizonMs") ?? 300000);
const sampleN = Number(args.get("sample") ?? 0);
const verbose = args.get("verbose") === "true";
const dbRaw = args.get("db") ?? "data/dev.db";
const dbPath = path.isAbsolute(dbRaw) ? dbRaw : path.join(repoRoot, dbRaw);

const { sqlite } = openDatabase(dbPath);
const now = Date.now();
const since = now - hours * 60 * 60 * 1000;

const rows = sqlite
  .prepare(
    `SELECT
       f.id as fillId,
       f.ts as fillTs,
       o.token_id as tokenId,
       o.side as side,
       m.mid_at_fill as midAtFill,
       m.mid_at_horizon as midAtHorizon,
       m.markout_bps as markoutBps
     FROM shadow_fills f
     JOIN shadow_orders o ON o.id = f.order_id
     JOIN shadow_markouts m ON m.fill_id = f.id AND m.horizon_ms = ?
     WHERE f.ts >= ?
       AND f.method != 'synthetic_fill'
       AND o.kind IN ('TAKER_BUY','TAKER_SELL')
       AND o.execution_mode = 'SHADOW'
     ORDER BY f.id ASC`
  )
  .all(horizonMs, since) as Row[];

// Guard A: join integrity
const totalRows = rows.length;
const distinctFills = new Set(rows.map((r) => r.fillId)).size;
if (totalRows !== distinctFills) {
  console.error(
    `[validate-markout] FAIL: Join integrity. rows=${totalRows} distinct_fills=${distinctFills}. ` +
      "Expected 1:1 fill:markout per horizon (dedupe bug or 1:many join)."
  );
  process.exit(1);
}

const featureAtOrBeforeStmt = sqlite.prepare(
  `SELECT mid FROM features WHERE token_id = ? AND ts <= ? AND mid IS NOT NULL ORDER BY ts DESC LIMIT 1`
);
const featureAtOrAfterStmt = sqlite.prepare(
  `SELECT mid FROM features WHERE token_id = ? AND ts >= ? AND mid IS NOT NULL ORDER BY ts ASC LIMIT 1`
);

let checkAPassed = 0;
let checkAFailed = 0;
const diffsA: number[] = [];
let checkBPassed = 0;
let checkBFailed = 0;
const diffsB: number[] = [];
const sampleRows: Array<{
  fillId: number;
  fillTs: number;
  tokenId: string;
  side: string;
  storedBps: number | null;
  recomputedA: number | null;
  recomputedB: number | null;
  diffA: number | null;
  diffB: number | null;
  reasonB?: string;
}> = [];

for (const r of rows) {
  const side = r.side === "BUY" || r.side === "SELL" ? r.side : "BUY";
  const stored = r.markoutBps != null && Number.isFinite(r.markoutBps) ? r.markoutBps : null;
  const midF = r.midAtFill;
  const midH = r.midAtHorizon;

  let recomputedA: number | null = null;
  let diffA: number | null = null;
  if (midF != null && midH != null && Number.isFinite(midF) && Number.isFinite(midH) && midF > 0) {
    recomputedA = computeMarkoutBps(side, midF, midH);
    if (stored != null) {
      diffA = Math.abs(recomputedA - stored);
      if (diffA <= TOLERANCE_ARITHMETIC_BPS) {
        checkAPassed += 1;
      } else {
        checkAFailed += 1;
      }
      diffsA.push(diffA);
    }
  }

  let recomputedB: number | null = null;
  let diffB: number | null = null;
  let reasonB: string | undefined;
  const featBefore = featureAtOrBeforeStmt.get(r.tokenId, r.fillTs) as { mid: number } | undefined;
  const featAfter = featureAtOrAfterStmt.get(r.tokenId, r.fillTs + horizonMs) as
    | { mid: number }
    | undefined;
  if (!featBefore?.mid || !Number.isFinite(featBefore.mid) || featBefore.mid <= 0) {
    reasonB = "no feature at fill_ts";
  } else if (!featAfter?.mid || !Number.isFinite(featAfter.mid) || featAfter.mid <= 0) {
    reasonB = "no feature at fill_ts+horizon";
  } else {
    recomputedB = computeMarkoutBps(side, featBefore.mid, featAfter.mid);
    if (stored != null) {
      diffB = Math.abs(recomputedB - stored);
      if (diffB <= TOLERANCE_FEATURES_BPS) {
        checkBPassed += 1;
      } else {
        checkBFailed += 1;
      }
      diffsB.push(diffB);
    }
  }

  if (sampleN > 0 && sampleRows.length < sampleN) {
    sampleRows.push({
      fillId: r.fillId,
      fillTs: r.fillTs,
      tokenId: r.tokenId,
      side,
      storedBps: stored,
      recomputedA,
      recomputedB,
      diffA,
      diffB,
      reasonB
    });
  }
}

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "—");

console.log(`[validate-markout] DB: ${dbPath}`);
console.log(`[validate-markout] window: last ${hours}h | horizonMs: ${horizonMs}`);
console.log(`[validate-markout] taker fills with markout: ${rows.length}`);
console.log("");
console.log("Guard A (join integrity): PASS (rows == distinct_fills)");
console.log("");
console.log("Check A (arithmetic from stored mids):");
console.log(`  passed: ${checkAPassed} failed: ${checkAFailed}`);
if (diffsA.length > 0) {
  const sorted = [...diffsA].sort((a, b) => a - b);
  const p50 = percentile(diffsA, 0.5);
  const p95 = percentile(diffsA, 0.95);
  const max = Math.max(...diffsA);
  console.log(`  abs diff: p50=${fmt(p50)} p95=${fmt(p95)} max=${fmt(max)} bps`);
}
console.log("");
console.log("Check B (recompute from features):");
console.log(`  passed: ${checkBPassed} failed: ${checkBFailed} (excl. missing features)`);
if (diffsB.length > 0) {
  const p50 = percentile(diffsB, 0.5);
  const p95 = percentile(diffsB, 0.95);
  const max = Math.max(...diffsB);
  console.log(`  abs diff: p50=${fmt(p50)} p95=${fmt(p95)} max=${fmt(max)} bps`);
}

if (sampleRows.length > 0) {
  console.log("");
  console.log("Sample (first " + sampleRows.length + "):");
  for (const s of sampleRows) {
    const line =
      `  fillId=${s.fillId} ts=${s.fillTs} ${s.tokenId} ${s.side} ` +
      `stored=${fmt(s.storedBps ?? NaN)} recA=${fmt(s.recomputedA ?? NaN)} recB=${s.recomputedB != null ? fmt(s.recomputedB) : (s.reasonB ?? "—")} ` +
      `diffA=${s.diffA != null ? fmt(s.diffA) : "—"} diffB=${s.diffB != null ? fmt(s.diffB) : (s.reasonB ?? "—")}`;
    console.log(line);
  }
}

if (verbose && rows.length > 0) {
  const missingFeatAtFill = rows.filter((_, i) => {
    const r = rows[i]!;
    const f = featureAtOrBeforeStmt.get(r.tokenId, r.fillTs);
    return !f;
  }).length;
  const missingFeatAtHorizon = rows.filter((_, i) => {
    const r = rows[i]!;
    const f = featureAtOrAfterStmt.get(r.tokenId, r.fillTs + horizonMs);
    return !f;
  }).length;
  console.log("");
  console.log("Missing features: no feature at fill_ts:", missingFeatAtFill);
  console.log("Missing features: no feature at fill_ts+horizon:", missingFeatAtHorizon);
}

const ok = checkAFailed === 0 && (diffsB.length === 0 || checkBFailed === 0);
if (!ok) {
  process.exit(1);
}

sqlite.close();
