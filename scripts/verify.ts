/* eslint-disable no-console */
// Usage:
//   npx tsx scripts/verify.ts [--db ./data/dev.db] [--hours 6] [--horizonMs 300000]
//   npx tsx scripts/verify.ts --horizonMs 30000,60000,300000   # multi-horizon summary + full diagnostics for primary (last)
// Fast evidence: gate net_edge_bps >= 150, run 2-6h, evaluate with median + bootstrap CI.

import Database from "better-sqlite3";

type Args = { db: string; hours: number; horizonMsList: number[] };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const i = argv.indexOf(k);
    if (i === -1) return def;
    return argv[i + 1];
  };

  const db = get("--db", "./data/dev.db")!;
  const hours = Number(get("--hours", "6"));
  const horizonMsRaw = get("--horizonMs", "300000")!;
  const horizonMsList = horizonMsRaw.split(",").map((s) => Number(s.trim())).filter((h) => Number.isFinite(h) && h > 0);
  if (!horizonMsList.length) throw new Error("--horizonMs must be > 0 (e.g. 300000 or 30000,60000,300000)");

  if (!Number.isFinite(hours) || hours <= 0) throw new Error("--hours must be > 0");

  return { db, hours, horizonMsList };
}

function q(db: Database.Database, sql: string, params: any[] = []) {
  return db.prepare(sql).all(...params);
}

function one(db: Database.Database, sql: string, params: any[] = []) {
  return db.prepare(sql).get(...params) as any;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = one(db, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [name]);
  return !!row?.name;
}

function columns(db: Database.Database, table: string): string[] {
  return q(db, `PRAGMA table_info(${table})`).map((r: any) => String(r.name));
}

function pickColumn(cols: string[], candidates: string[]): string | null {
  const set = new Set(cols.map((c) => c.toLowerCase()));
  for (const cand of candidates) {
    if (set.has(cand.toLowerCase())) return cols.find((c) => c.toLowerCase() === cand.toLowerCase())!;
  }
  return null;
}

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

function mean(xs: number[]) {
  if (!xs.length) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[]) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

// Normal CDF approximation (good enough for diagnostics)
function phi(z: number) {
  // Abramowitz-Stegun-ish approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - p : p;
}

function pearson(x: number[], y: number[]) {
  if (x.length !== y.length || x.length < 2) return NaN;
  const mx = mean(x);
  const my = mean(y);
  let num = 0,
    dx = 0,
    dy = 0;
  for (let i = 0; i < x.length; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return num / Math.sqrt(dx * dy);
}

function fmt(n: number, digits = 2) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function percentile(xs: number[], p: number): number {
  if (!xs.length || p < 0 || p > 1) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const i = p * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (i - lo) * (sorted[hi] - sorted[lo]);
}

function quantiles(xs: number[], ps: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of ps) out[`p${Math.round(p * 100)}`] = percentile(xs, p);
  return out;
}

function median(xs: number[]): number {
  return percentile(xs, 0.5);
}

function trimmedMean(xs: number[], trimFrac: number): number {
  if (!xs.length || trimFrac < 0 || trimFrac >= 0.5) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const drop = Math.floor(sorted.length * trimFrac);
  const slice = sorted.slice(drop, sorted.length - drop);
  return slice.length ? mean(slice) : NaN;
}

function winRate(xs: number[]): number {
  if (!xs.length) return NaN;
  return xs.filter((x) => x > 0).length / xs.length;
}

function winsorizedMean(xs: number[], loFrac: number, hiFrac: number): number {
  if (!xs.length || loFrac < 0 || hiFrac > 1 || loFrac >= hiFrac) return NaN;
  const loCap = percentile(xs, loFrac);
  const hiCap = percentile(xs, hiFrac);
  const capped = xs.map((x) => clamp(x, loCap, hiCap));
  return mean(capped);
}

const BOOTSTRAP_B = 2000;

function bootstrapCiMean(xs: number[], alpha: number): [number, number] {
  if (!xs.length || xs.length < 2) return [NaN, NaN];
  const n = xs.length;
  const means: number[] = [];
  for (let b = 0; b < BOOTSTRAP_B; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(Math.random() * n);
      sum += xs[j];
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const loIdx = Math.floor((alpha / 2) * (BOOTSTRAP_B - 1));
  const hiIdx = Math.ceil((1 - alpha / 2) * (BOOTSTRAP_B - 1));
  return [means[loIdx], means[hiIdx]];
}

function main() {
  const args = parseArgs();
  const db = new Database(args.db, { readonly: true });

  const requiredTables = ["shadow_orders", "shadow_fills", "shadow_markouts"];
  for (const t of requiredTables) {
    if (!tableExists(db, t)) {
      throw new Error(`Missing table: ${t}. Point --db at the correct SQLite file.`);
    }
  }

  const orderCols = columns(db, "shadow_orders");
  const fillCols = columns(db, "shadow_fills");
  const markoutCols = columns(db, "shadow_markouts");

  // Adjust these if your schema uses different names.
  const CANDIDATES = {
    orders: {
      id: ["id"],
      ts: ["ts", "created_at", "createdAt", "time_ms", "timeMs"],
      kind: ["kind", "side", "order_kind"],
      walletId: ["wallet_id", "walletId", "wallet"],
      tokenId: ["token_id", "tokenId", "token", "market_token_id"],
      predEdgeBps: ["pred_edge_bps", "predEdgeBps"],
      deltaHat: ["delta_hat", "deltaHat"],
      netEdgeBps: ["net_edge_bps", "netEdgeBps"],
      netAfterInvBps: ["net_edge_after_inventory_bps", "netEdgeAfterInventoryBps"],
      inventoryI: ["inventory_i", "inventoryI"],
      spreadBps: ["spread_bps", "spreadBps"],
      slippageBps: ["expected_slippage_bps", "slippage_bps", "expectedSlippageBps"],
    },
    fills: {
      id: ["id"],
      orderId: ["order_id", "orderId"],
      ts: ["ts", "created_at", "createdAt", "time_ms", "timeMs"],
    },
    markouts: {
      id: ["id"],
      fillId: ["fill_id", "fillId"],
      orderId: ["order_id", "orderId"],
      horizonMs: ["horizon_ms", "horizonMs"],
      bps: ["markout_bps", "bps", "markoutBps"],
      notional: ["notional", "notional_usd", "notionalUsd"],
    },
  };

  const o_id = pickColumn(orderCols, CANDIDATES.orders.id)!;
  const o_ts = pickColumn(orderCols, CANDIDATES.orders.ts);
  const o_kind = pickColumn(orderCols, CANDIDATES.orders.kind);
  const o_wallet = pickColumn(orderCols, CANDIDATES.orders.walletId);
  const o_token = pickColumn(orderCols, CANDIDATES.orders.tokenId);

  const f_id = pickColumn(fillCols, CANDIDATES.fills.id)!;
  const f_orderId = pickColumn(fillCols, CANDIDATES.fills.orderId);
  const f_ts = pickColumn(fillCols, CANDIDATES.fills.ts);

  const m_fillId = pickColumn(markoutCols, CANDIDATES.markouts.fillId);
  const m_orderId = pickColumn(markoutCols, CANDIDATES.markouts.orderId);
  const m_horizon = pickColumn(markoutCols, CANDIDATES.markouts.horizonMs);
  const m_bps = pickColumn(markoutCols, CANDIDATES.markouts.bps);
  const m_notional = pickColumn(markoutCols, CANDIDATES.markouts.notional);

  if (!o_ts) throw new Error("Could not find shadow_orders timestamp column (ts/created_at/...).");
  if (!m_bps) throw new Error("Could not find markout bps column (markout_bps/bps/...).");
  if (!m_horizon) throw new Error("Could not find markout horizon column (horizon_ms/...).");

  const sinceTs = Date.now() - args.hours * 3600 * 1000;

  // Basic funnel counts (windowed on order ts)
  const ordersTotal = one(
    db,
    `SELECT COUNT(*) as n FROM shadow_orders WHERE ${o_ts} >= ?`,
    [sinceTs]
  ).n as number;

  const fillsTotal =
    f_ts
      ? (one(db, `SELECT COUNT(*) as n FROM shadow_fills WHERE ${f_ts} >= ?`, [sinceTs]).n as number)
      : (one(db, `SELECT COUNT(*) as n FROM shadow_fills`).n as number);

  // Join strategy: prefer markouts joined to fills; fallback to order join if needed.
  let joinSql = "";
  if (m_fillId && f_orderId) {
    joinSql = `
      SELECT
        o.${o_id} as order_id,
        o.${o_ts} as order_ts
        ${o_kind ? `, o.${o_kind} as kind` : ""}
        ${o_wallet ? `, o.${o_wallet} as wallet_id` : ""}
        ${o_token ? `, o.${o_token} as token_id` : ""}
        ${pickColumn(orderCols, CANDIDATES.orders.predEdgeBps) ? `, o.${pickColumn(orderCols, CANDIDATES.orders.predEdgeBps)} as pred_edge_bps` : ""}
        ${pickColumn(orderCols, CANDIDATES.orders.deltaHat) ? `, o.${pickColumn(orderCols, CANDIDATES.orders.deltaHat)} as delta_hat` : ""}
        ${pickColumn(orderCols, CANDIDATES.orders.netEdgeBps) ? `, o.${pickColumn(orderCols, CANDIDATES.orders.netEdgeBps)} as net_edge_bps` : ""}
        ${pickColumn(orderCols, CANDIDATES.orders.netAfterInvBps) ? `, o.${pickColumn(orderCols, CANDIDATES.orders.netAfterInvBps)} as net_after_inv_bps` : ""}
        ${pickColumn(orderCols, CANDIDATES.orders.inventoryI) ? `, o.${pickColumn(orderCols, CANDIDATES.orders.inventoryI)} as inventory_i` : ""}
        ${pickColumn(orderCols, CANDIDATES.orders.spreadBps) ? `, o.${pickColumn(orderCols, CANDIDATES.orders.spreadBps)} as spread_bps` : ""}
        ${pickColumn(orderCols, CANDIDATES.orders.slippageBps) ? `, o.${pickColumn(orderCols, CANDIDATES.orders.slippageBps)} as slippage_bps` : ""}
        , f.${f_id} as fill_id
        , m.${m_bps} as markout_bps
        , m.${m_horizon} as horizon_ms
        ${m_notional ? `, m.${m_notional} as notional` : ""}
      FROM shadow_orders o
      JOIN shadow_fills f ON f.${f_orderId} = o.${o_id}
      JOIN shadow_markouts m ON m.${m_fillId} = f.${f_id}
      WHERE o.${o_ts} >= ?
        AND m.${m_horizon} = ?
        AND m.${m_bps} IS NOT NULL
    `;
  } else if (m_orderId) {
    joinSql = `
      SELECT
        o.${o_id} as order_id,
        o.${o_ts} as order_ts
        ${o_kind ? `, o.${o_kind} as kind` : ""}
        ${o_wallet ? `, o.${o_wallet} as wallet_id` : ""}
        ${o_token ? `, o.${o_token} as token_id` : ""}
        ${pickColumn(orderCols, CANDIDATES.orders.predEdgeBps) ? `, o.${pickColumn(orderCols, CANDIDATES.orders.predEdgeBps)} as pred_edge_bps` : ""}
        ${pickColumn(orderCols, CANDIDATES.orders.deltaHat) ? `, o.${pickColumn(orderCols, CANDIDATES.orders.deltaHat)} as delta_hat` : ""}
        ${pickColumn(orderCols, CANDIDATES.orders.netEdgeBps) ? `, o.${pickColumn(orderCols, CANDIDATES.orders.netEdgeBps)} as net_edge_bps` : ""}
        ${pickColumn(orderCols, CANDIDATES.orders.netAfterInvBps) ? `, o.${pickColumn(orderCols, CANDIDATES.orders.netAfterInvBps)} as net_after_inv_bps` : ""}
        ${pickColumn(orderCols, CANDIDATES.orders.inventoryI) ? `, o.${pickColumn(orderCols, CANDIDATES.orders.inventoryI)} as inventory_i` : ""}
        ${pickColumn(orderCols, CANDIDATES.orders.spreadBps) ? `, o.${pickColumn(orderCols, CANDIDATES.orders.spreadBps)} as spread_bps` : ""}
        ${pickColumn(orderCols, CANDIDATES.orders.slippageBps) ? `, o.${pickColumn(orderCols, CANDIDATES.orders.slippageBps)} as slippage_bps` : ""}
        , NULL as fill_id
        , m.${m_bps} as markout_bps
        , m.${m_horizon} as horizon_ms
        ${m_notional ? `, m.${m_notional} as notional` : ""}
      FROM shadow_orders o
      JOIN shadow_markouts m ON m.${m_orderId} = o.${o_id}
      WHERE o.${o_ts} >= ?
        AND m.${m_horizon} = ?
        AND m.${m_bps} IS NOT NULL
    `;
  } else {
    throw new Error("Could not determine how to join markouts (need markouts.fill_id or markouts.order_id).");
  }

  const primaryHorizon = args.horizonMsList[args.horizonMsList.length - 1];

  if (args.horizonMsList.length > 1) {
    console.log("");
    console.log("=== Multi-horizon summary (median + bootstrap CI) ===");
    console.log("horizonMs   n    mean   median  trim10  winsorized  bootstrap_95%_CI");
    for (const horizonMs of args.horizonMsList) {
      const hr = q(db, joinSql, [sinceTs, horizonMs]);
      const ys = (hr as any[]).map((r: any) => Number(r.markout_bps)).filter((x: number) => Number.isFinite(x));
      if (!ys.length) {
        console.log(`${String(horizonMs).padStart(9)}     0   —      —       —       —         [—, —]`);
        continue;
      }
      const [bootLo, bootHi] = bootstrapCiMean(ys, 0.05);
      console.log(
        `${String(horizonMs).padStart(9)} ${String(ys.length).padStart(5)} ${fmt(mean(ys)).padStart(6)} ${fmt(median(ys)).padStart(7)} ${fmt(trimmedMean(ys, 0.1)).padStart(7)} ${fmt(winsorizedMean(ys, 0.05, 0.95)).padStart(10)}  [${fmt(bootLo)}, ${fmt(bootHi)}]`
      );
    }
    console.log("");
  }

  const rows = q(db, joinSql, [sinceTs, primaryHorizon]);

  const markouts = rows.map((r: any) => Number(r.markout_bps)).filter((x: number) => Number.isFinite(x));
  const m = mean(markouts);
  const s = std(markouts);
  const n = markouts.length;
  const se = n > 1 && Number.isFinite(s) ? s / Math.sqrt(n) : NaN;
  const ciLo = Number.isFinite(se) ? m - 1.96 * se : NaN;
  const ciHi = Number.isFinite(se) ? m + 1.96 * se : NaN;
  const pMeanGt0 = Number.isFinite(se) ? 1 - phi((0 - m) / se) : NaN;

  // Calibration: pred_edge_bps buckets if present
  const hasPred = rows.some((r: any) => r.pred_edge_bps !== undefined && r.pred_edge_bps !== null);
  const edgePairs: { pred: number; real: number }[] = [];
  if (hasPred) {
    for (const r of rows) {
      const pred = Number((r as any).pred_edge_bps);
      const real = Number((r as any).markout_bps);
      if (Number.isFinite(pred) && Number.isFinite(real)) edgePairs.push({ pred, real });
    }
  }

  const corr = hasPred ? pearson(edgePairs.map((p) => p.pred), edgePairs.map((p) => p.real)) : NaN;

  const predValues = hasPred ? edgePairs.map((p) => p.pred).filter((x) => Number.isFinite(x)) : [];
  const predQuantiles =
    predValues.length > 0
      ? {
          min: Math.min(...predValues),
          p01: percentile(predValues, 0.01),
          p05: percentile(predValues, 0.05),
          p25: percentile(predValues, 0.25),
          p50: percentile(predValues, 0.5),
          p75: percentile(predValues, 0.75),
          p95: percentile(predValues, 0.95),
          p99: percentile(predValues, 0.99),
          max: Math.max(...predValues),
          distinct: new Set(predValues.map((v) => Math.round(v * 100) / 100)).size,
        }
      : null;

  const hasNet = rows.some((r: any) => r.net_edge_bps !== undefined && r.net_edge_bps !== null);
  const netEdgePairs: { net: number; real: number }[] = [];
  if (hasNet) {
    for (const r of rows) {
      const net = Number((r as any).net_edge_bps);
      const real = Number((r as any).markout_bps);
      if (Number.isFinite(net) && Number.isFinite(real)) netEdgePairs.push({ net, real });
    }
  }
  const corrNet = hasNet && netEdgePairs.length > 1 ? pearson(netEdgePairs.map((p) => p.net), netEdgePairs.map((p) => p.real)) : NaN;

  // Buckets in bps
  const BUCKETS = [0, 10, 25, 50, 100, 200, Infinity];
  function bucketLabel(i: number) {
    const a = BUCKETS[i];
    const b = BUCKETS[i + 1];
    if (b === Infinity) return `${a}+`;
    return `${a}-${b}`;
  }

  const bucketStats: any[] = [];
  if (hasPred) {
    for (let i = 0; i < BUCKETS.length - 1; i++) {
      const a = BUCKETS[i];
      const b = BUCKETS[i + 1];
      const ys = edgePairs
        .filter((p) => p.pred >= a && p.pred < b)
        .map((p) => p.real);
      bucketStats.push({
        bucket: bucketLabel(i),
        n: ys.length,
        meanReal: mean(ys),
        stdReal: std(ys),
      });
    }
  }

  const netBucketStats: any[] = [];
  if (hasNet) {
    for (let i = 0; i < BUCKETS.length - 1; i++) {
      const a = BUCKETS[i];
      const b = BUCKETS[i + 1];
      const ys = netEdgePairs
        .filter((p) => p.net >= a && p.net < b)
        .map((p) => p.real);
      netBucketStats.push({
        bucket: bucketLabel(i),
        n: ys.length,
        meanReal: mean(ys),
        stdReal: std(ys),
      });
    }
  }

  // Kind breakdown (maker vs taker)
  const byKind = new Map<string, number[]>();
  for (const r of rows) {
    const k = (r as any).kind ?? "UNKNOWN";
    const v = Number((r as any).markout_bps);
    if (!Number.isFinite(v)) continue;
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k)!.push(v);
  }

  // Sample-size targets: how many markouts needed to get CI half-width <= delta
  const deltas = [1, 2, 5]; // bps
  const nTargets = deltas.map((d) => ({
    deltaBps: d,
    nNeeded: Number.isFinite(s) && s > 0 ? Math.ceil((1.96 * s / d) ** 2) : null,
  }));

  const TINY_N = 30;

  console.log("");
  console.log("=== Edge Proof (windowed diagnostics) ===");
  console.log(`DB: ${args.db}`);
  console.log(`Window: last ${args.hours}h | sinceTs=${sinceTs} | primary horizonMs=${primaryHorizon}`);
  console.log("");
  console.log("Markout: markout_bps is trade-PnL-signed (BUY: +priceMove, SELL: -priceMove). Source: ShadowExecutionLoop.");
  console.log("");

  console.log("Funnel:");
  console.log(`  orders (shadow_orders): ${ordersTotal}`);
  console.log(`  fills  (shadow_fills):  ${fillsTotal}`);
  console.log(`  markouts@horizon:       ${n}`);
  console.log(`  markouts per order:     ${ordersTotal ? fmt(n / ordersTotal, 4) : "—"}`);
  console.log("");

  if (predQuantiles) {
    console.log("pred_edge_bps distribution (explains empty buckets):");
    console.log(
      `  min=${fmt(predQuantiles.min)} p01=${fmt(predQuantiles.p01)} p05=${fmt(predQuantiles.p05)} p25=${fmt(predQuantiles.p25)} p50=${fmt(predQuantiles.p50)} p75=${fmt(predQuantiles.p75)} p95=${fmt(predQuantiles.p95)} p99=${fmt(predQuantiles.p99)} max=${fmt(predQuantiles.max)}`
    );
    console.log(`  distinct (rounded to 0.01): ${predQuantiles.distinct}`);
    console.log("");
  }

  if (hasNet && netEdgePairs.length > 0) {
    const netValues = netEdgePairs.map((p) => p.net).filter((x) => Number.isFinite(x));
    if (netValues.length > 0) {
      console.log("net_edge_bps distribution:");
      const nq = {
        min: Math.min(...netValues),
        p50: percentile(netValues, 0.5),
        p95: percentile(netValues, 0.95),
        max: Math.max(...netValues),
        distinct: new Set(netValues.map((v) => Math.round(v * 100) / 100)).size,
      };
      console.log(`  min=${fmt(nq.min)} p50=${fmt(nq.p50)} p95=${fmt(nq.p95)} max=${fmt(nq.max)} distinct(0.01)=${nq.distinct}`);
      console.log("");
    }
  }

  const [bootCiLo, bootCiHi] = bootstrapCiMean(markouts, 0.05);
  console.log("Realized markout (bps):");
  console.log(`  mean: ${fmt(m)} | median: ${fmt(median(markouts))} | trim10%: ${fmt(trimmedMean(markouts, 0.1))} | winsorized(5,95): ${fmt(winsorizedMean(markouts, 0.05, 0.95))} | std: ${fmt(s)} | n: ${n}`);
  console.log(`  95% CI(mean, normal): [${fmt(ciLo)}, ${fmt(ciHi)}]`);
  console.log(`  95% CI(mean, bootstrap): [${fmt(bootCiLo)}, ${fmt(bootCiHi)}]`);
  console.log(`  P(mean > 0): ${fmt(pMeanGt0, 4)}`);
  console.log("");

  console.log("By kind (mean | median | trimmed10% | winRate | std):");
  for (const [k, ys] of Array.from(byKind.entries()).sort((a, b) => b[1].length - a[1].length)) {
    const tiny = ys.length < TINY_N ? " (n tiny, no evidence yet)" : "";
    console.log(
      `  ${k.padEnd(12)} n=${String(ys.length).padStart(4)} mean=${fmt(mean(ys))} median=${fmt(median(ys))} trim10=${fmt(trimmedMean(ys, 0.1))} winRate=${fmt(winRate(ys), 2)} std=${fmt(std(ys))}${tiny}`
    );
  }
  console.log("");

  if (hasPred) {
    console.log("Calibration (pred_edge_bps vs realized markout_bps):");
    console.log(`  corr(pred, realized) = ${fmt(corr, 4)}`);
    console.log("  buckets:");
    for (const b of bucketStats) {
      console.log(
        `    ${String(b.bucket).padEnd(8)} n=${String(b.n).padStart(4)} meanReal=${fmt(b.meanReal)} stdReal=${fmt(b.stdReal)}`
      );
    }
    const lowBucket = bucketStats.find((b) => b.bucket === "0-10");
    if (lowBucket && lowBucket.n >= 10 && Number.isFinite(lowBucket.meanReal) && lowBucket.meanReal < -5) {
      console.log("  >>> 0-10 bps bucket strongly negative → consider gate: do not trade when net_edge_bps < 10-20 bps.");
    }
    console.log("");
  } else {
    console.log("Calibration: pred_edge_bps not found on shadow_orders (skip).");
    console.log("");
  }

  if (hasNet && netBucketStats.length > 0) {
    console.log("Calibration (net_edge_bps vs realized markout_bps) — trading reality:");
    console.log(`  corr(net, realized) = ${fmt(corrNet, 4)}`);
    console.log("  buckets:");
    for (const b of netBucketStats) {
      console.log(
        `    ${String(b.bucket).padEnd(8)} n=${String(b.n).padStart(4)} meanReal=${fmt(b.meanReal)} stdReal=${fmt(b.stdReal)}`
      );
    }
    const lowNetBucket = netBucketStats.find((b) => b.bucket === "0-10");
    if (lowNetBucket && lowNetBucket.n >= 10 && Number.isFinite(lowNetBucket.meanReal) && lowNetBucket.meanReal < -5) {
      console.log("  >>> 0-10 net_edge bucket strongly negative → gate net_edge_bps >= 10-20 bps.");
    }
    console.log("");
  }

  const hasDeltaHat = rows.some((r: any) => r.delta_hat !== undefined && r.delta_hat !== null);
  if (hasDeltaHat && rows.length > 0) {
    const absDeltaHat: number[] = [];
    const absRealizedFrac: number[] = [];
    for (const r of rows) {
      const dh = Number((r as any).delta_hat);
      const mb = Number((r as any).markout_bps);
      if (Number.isFinite(dh) && Number.isFinite(mb)) {
        absDeltaHat.push(Math.abs(dh));
        absRealizedFrac.push(Math.abs(mb) / 10_000);
      }
    }
    if (absDeltaHat.length > 0 && absRealizedFrac.length > 0) {
      const medDh = percentile(absDeltaHat, 0.5);
      const p90Dh = percentile(absDeltaHat, 0.9);
      const p99Dh = percentile(absDeltaHat, 0.99);
      const medReal = percentile(absRealizedFrac, 0.5);
      const scaleRatio = medReal > 1e-8 ? medDh / medReal : NaN;
      console.log("DeltaHat scale (median + quantiles, vs realized):");
      console.log(`  median(|deltaHat|)=${fmt(medDh, 6)} p90=${fmt(p90Dh, 6)} p99=${fmt(p99Dh, 6)}`);
      console.log(`  median(|realized_frac|)=${fmt(medReal, 6)} (|markout_bps|/10000)`);
      console.log(`  scaleRatio = median(|deltaHat|)/median(|realized|) = ${fmt(scaleRatio, 2)}`);
      if (Number.isFinite(scaleRatio) && scaleRatio > 50) {
        console.log(
          `  >>> DeltaHat scale mismatch: median |deltaHat| ≈ ${fmt(medDh)} vs median |realized| ≈ ${fmt(medReal)}. Predicted moves may be overstated (or units wrong).`
        );
      }
      console.log("");
    }
  }

  console.log("Sample-size targets (markouts) for CI half-width <= delta:");
  for (const t of nTargets) {
    console.log(`  delta=${t.deltaBps} bps -> nNeeded=${t.nNeeded ?? "— (need std)"} markouts`);
  }
  console.log("");

  const bucketMeans = (stats: { n: number; meanReal: number }[]) =>
    stats.filter((b) => b.n > 0).map((b) => b.meanReal);
  const monotonic = (means: number[]) => {
    if (means.length < 2) return true;
    for (let i = 1; i < means.length; i++) if (means[i] < means[i - 1] - 1) return false;
    return true;
  };
  const calibStats = hasNet ? netBucketStats : bucketStats;
  const calibMeans = bucketMeans(calibStats);
  const calibMonotonic = calibMeans.length >= 2 && monotonic(calibMeans);
  const corrUsed = hasNet ? corrNet : corr;
  const atLeastOneKindPositive =
    Array.from(byKind.entries()).filter(([, ys]) => ys.length >= TINY_N && mean(ys) > 0).length > 0;
  const evidenceOk =
    Number.isFinite(ciLo) &&
    ciLo > 0 &&
    (hasPred || hasNet) &&
    Number.isFinite(corrUsed) &&
    corrUsed > 0.2 &&
    calibMonotonic &&
    atLeastOneKindPositive;

  console.log("Notes:");
  console.log("  - Treat these as diagnostics, not a formal proof (markouts are not perfectly iid).");
  console.log("  - Fast evidence: gate net_edge_bps >= 150, run 2-6h, evaluate with median + bootstrap CI (stop when CI entirely > 0).");
  console.log("  - Working: CI(mean) > 0, calibration monotonic, corr > 0.2, edge persists by kind.");
  console.log("  - Not working: CI crosses 0 for weeks, calibration flat/inverted, best bucket disappears after costs.");
  console.log("  - If P(mean>0) ~0.5 with wide CI => not enough evidence; collect more markouts (see nNeeded above).");
  console.log(
    `  - Evidence status: ${evidenceOk ? "working (CI>0, corr>0.2, monotonic, kind)" : "not met (need more n or better calibration)"}`
  );
  console.log("");
}

main();
