#!/usr/bin/env npx tsx
/**
 * Taker sample audit: export last N taker fills for manual verification.
 * Includes slippage vs touch (are we paying spread + extra?).
 *
 * Usage:
 *   npx tsx scripts/archive/manual-diagnostics/validate-taker-sample-audit.ts --limit=20
 *   npx tsx scripts/archive/manual-diagnostics/validate-taker-sample-audit.ts --limit=20 --format=csv > audit.csv
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../../packages/storage/src/index.js";

function computeMarkoutBps(side: "BUY" | "SELL", midAtFill: number, midAtHorizon: number): number {
  const pnl =
    side === "BUY"
      ? (midAtHorizon - midAtFill) / midAtFill
      : (midAtFill - midAtHorizon) / midAtFill;
  return pnl * 10_000;
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
const limit = Math.max(1, Math.min(500, Number(args.get("limit") ?? 20)));
const format = args.get("format") ?? "table";
const horizons = (args.get("horizons") ?? "5000,30000,300000")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v > 0);
const dbRaw = args.get("db") ?? "data/dev.db";
const dbPath = path.isAbsolute(dbRaw) ? dbRaw : path.join(repoRoot, dbRaw);

const { sqlite } = openDatabase(dbPath);
const now = Date.now();
const since = now - hours * 60 * 60 * 1000;

type FillRow = {
  fillId: number;
  fillTs: number;
  tokenId: string;
  side: "BUY" | "SELL";
  fillPrice: number | null;
  size: number | null;
  predEdgeBps: number | null;
  netEdgeBps: number | null;
  costBps: number | null;
};

const fills = sqlite
  .prepare(
    `SELECT
       f.id as fillId,
       f.ts as fillTs,
       o.token_id as tokenId,
       o.side as side,
       f.price as fillPrice,
       f.size as size,
       o.pred_edge_bps as predEdgeBps,
       o.net_edge_bps as netEdgeBps,
       o.cost_bps as costBps
     FROM shadow_fills f
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE f.ts >= ?
       AND f.method != 'synthetic_fill'
       AND o.kind IN ('TAKER_BUY','TAKER_SELL')
       AND o.execution_mode = 'SHADOW'
     ORDER BY f.id DESC
     LIMIT ?`
  )
  .all(since, limit) as FillRow[];

const featureAtOrBeforeStmt = sqlite.prepare(
  `SELECT mid, best_bid as bestBid, best_ask as bestAsk
   FROM features
   WHERE token_id = ? AND ts <= ? AND mid IS NOT NULL
   ORDER BY ts DESC
   LIMIT 1`
);
const featureAtOrAfterStmt = sqlite.prepare(
  `SELECT mid FROM features WHERE token_id = ? AND ts >= ? AND mid IS NOT NULL ORDER BY ts ASC LIMIT 1`
);
const markoutStmt = sqlite.prepare(
  `SELECT markout_bps as markoutBps FROM shadow_markouts WHERE fill_id = ? AND horizon_ms = ?`
);

type AuditRow = {
  ts: number;
  tokenId: string;
  side: string;
  fillPrice: number | null;
  midAtFill: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  touchPrice: number | null;
  slippageBps: number | null;
  midVsFillBps: number | null;
  predEdgeBps: number | null;
  netEdgeBps: number | null;
  costBps: number | null;
  byHorizon: Record<
    number,
    { midAtHorizon: number | null; markoutDb: number | null; markoutRecomputed: number | null }
  >;
};

const rows: AuditRow[] = [];

for (const fill of fills) {
  const side = fill.side === "BUY" || fill.side === "SELL" ? fill.side : "BUY";
  const feat = featureAtOrBeforeStmt.get(fill.tokenId, fill.fillTs) as
    | { mid: number; bestBid: number | null; bestAsk: number | null }
    | undefined;

  const midAtFill = feat?.mid ?? null;
  const bestBid = feat?.bestBid ?? null;
  const bestAsk = feat?.bestAsk ?? null;

  const touchPrice =
    side === "BUY" ? (bestAsk ?? null) : side === "SELL" ? (bestBid ?? null) : null;

  let slippageBps: number | null = null;
  if (
    fill.fillPrice != null &&
    touchPrice != null &&
    Number.isFinite(fill.fillPrice) &&
    Number.isFinite(touchPrice) &&
    touchPrice > 0
  ) {
    const dir = side === "BUY" ? fill.fillPrice - touchPrice : touchPrice - fill.fillPrice;
    slippageBps = (dir / touchPrice) * 10_000;
  }

  let midVsFillBps: number | null = null;
  if (
    fill.fillPrice != null &&
    midAtFill != null &&
    Number.isFinite(fill.fillPrice) &&
    Number.isFinite(midAtFill) &&
    midAtFill > 0
  ) {
    const dir = side === "BUY" ? fill.fillPrice - midAtFill : midAtFill - fill.fillPrice;
    midVsFillBps = (dir / midAtFill) * 10_000;
  }

  const byHorizon: Record<
    number,
    { midAtHorizon: number | null; markoutDb: number | null; markoutRecomputed: number | null }
  > = {};
  for (const h of horizons) {
    const mRow = markoutStmt.get(fill.fillId, h) as { markoutBps: number | null } | undefined;
    const markoutDb = mRow?.markoutBps ?? null;

    const featAfter = featureAtOrAfterStmt.get(fill.tokenId, fill.fillTs + h) as
      | { mid: number }
      | undefined;
    const midH = featAfter?.mid ?? null;
    const markoutRecomputed =
      midAtFill != null && midH != null && midAtFill > 0
        ? computeMarkoutBps(side, midAtFill, midH)
        : null;

    byHorizon[h] = { midAtHorizon: midH, markoutDb, markoutRecomputed };
  }

  rows.push({
    ts: fill.fillTs,
    tokenId: fill.tokenId,
    side,
    fillPrice: fill.fillPrice,
    midAtFill,
    bestBid,
    bestAsk,
    touchPrice,
    slippageBps,
    midVsFillBps,
    predEdgeBps: fill.predEdgeBps,
    netEdgeBps: fill.netEdgeBps,
    costBps: fill.costBps,
    byHorizon
  });
}

const fmt = (v: number | null): string =>
  v != null && Number.isFinite(v) ? String(v) : "";

if (format === "csv") {
  const primaryHorizon = horizons[horizons.length - 1] ?? 300000;
  const cols = [
    "ts",
    "tokenId",
    "side",
    "fillPrice",
    "midAtFill",
    "bestBid",
    "bestAsk",
    "touchPrice",
    "slippageBps",
    "midVsFillBps",
    `mid_${primaryHorizon}`,
    `markoutDb_${primaryHorizon}`,
    `markoutRecomputed_${primaryHorizon}`,
    "predEdgeBps",
    "netEdgeBps"
  ];
  console.log(cols.join(","));
  for (const r of rows) {
    const h = r.byHorizon[primaryHorizon];
    const line = [
      r.ts,
      r.tokenId,
      r.side,
      fmt(r.fillPrice),
      fmt(r.midAtFill),
      fmt(r.bestBid),
      fmt(r.bestAsk),
      fmt(r.touchPrice),
      fmt(r.slippageBps),
      fmt(r.midVsFillBps),
      fmt(h?.midAtHorizon ?? null),
      fmt(h?.markoutDb ?? null),
      fmt(h?.markoutRecomputed ?? null),
      fmt(r.predEdgeBps),
      fmt(r.netEdgeBps)
    ].join(",");
    console.log(line);
  }
} else {
  console.log(`[taker-sample-audit] DB: ${dbPath}`);
  console.log(`[taker-sample-audit] last ${limit} taker fills (${hours}h window)`);
  console.log("");
  for (const r of rows) {
    const h5m = r.byHorizon[300000];
    console.log(`fill ts=${r.ts} ${r.tokenId} ${r.side}`);
    console.log(
      `  fillPrice=${fmt(r.fillPrice)} midAtFill=${fmt(r.midAtFill)} bestBid=${fmt(r.bestBid)} bestAsk=${fmt(r.bestAsk)}`
    );
    console.log(
      `  touchPrice=${fmt(r.touchPrice)} slippageBps=${fmt(r.slippageBps)} midVsFillBps=${fmt(r.midVsFillBps)}`
    );
    console.log(`  predEdgeBps=${fmt(r.predEdgeBps)} netEdgeBps=${fmt(r.netEdgeBps)} costBps=${fmt(r.costBps)}`);
    for (const h of horizons) {
      const x = r.byHorizon[h];
      if (x)
        console.log(
          `  horizon ${h}ms: markoutDb=${fmt(x.markoutDb)} markoutRecomputed=${fmt(x.markoutRecomputed)}`
        );
    }
    console.log("");
  }
}

sqlite.close();
