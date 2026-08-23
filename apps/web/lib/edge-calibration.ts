import { getDb } from "./db";

const BUCKETS = [
  { label: "0-10 bps", min: 0, max: 10 },
  { label: "10-25 bps", min: 10, max: 25 },
  { label: "25-50 bps", min: 25, max: 50 },
  { label: "50+ bps", min: 50, max: 99999 }
];

export type CalibrationBucket = {
  label: string;
  count: number;
  avgRealizedMarkoutBps: number | null;
};

export type EdgeDecomposition = {
  avgPredEdgeBps: number | null;
  avgSpreadBps: number | null;
  avgFeesBps: number | null;
  avgExpectedSlippageBps: number | null;
  avgCostBps: number | null;
  avgNetEdgeBps: number | null;
  avgRealizedMarkoutBps: number | null;
  fillCount: number;
};

export type KindCalibration = {
  kind: string;
  buckets: CalibrationBucket[];
  decomposition: EdgeDecomposition;
};

export type CalibrationDiagnostics = {
  fills_total: number;
  fills_with_markout: number;
  fills_with_pred_edge: number;
  fills_in_calibration: number;
};

export type EdgeCalibrationData = {
  taker: KindCalibration;
  maker: KindCalibration;
  combined: {
    takerRealizedMarkoutBps: number | null;
    makerRealizedMarkoutBps: number | null;
    takerFills: number;
    makerFills: number;
    takerWinRate: number;
    makerFillRate: number;
  };
  diagnostics: {
    taker: CalibrationDiagnostics;
  };
};

function bucketIndex(netEdgeBps: number | null): number {
  if (netEdgeBps == null || !Number.isFinite(netEdgeBps)) return -1;
  for (let i = 0; i < BUCKETS.length; i++) {
    const b = BUCKETS[i];
    if (b && netEdgeBps >= b.min && netEdgeBps < b.max) return i;
  }
  const last = BUCKETS[BUCKETS.length - 1];
  return last && netEdgeBps >= last.min ? BUCKETS.length - 1 : -1;
}

function computeKindCalibration(
  sqlite: ReturnType<typeof getDb>["sqlite"],
  kinds: string[],
  horizonMs: number
): KindCalibration {
  const kindList = kinds.map((k) => `'${k}'`).join(",");
  const rows = sqlite
    .prepare(
      `SELECT
         o.kind,
         o.net_edge_bps as netEdgeBps,
         o.pred_edge_bps as predEdgeBps,
         o.spread_bps as spreadBps,
         o.fees_bps as feesBps,
         o.expected_slippage_bps as expectedSlippageBps,
         o.cost_bps as costBps,
         m.markout_bps as markoutBps
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       LEFT JOIN shadow_markouts m ON m.fill_id = f.id AND m.horizon_ms = ?
       WHERE o.kind IN (${kindList})
         AND o.pred_source != 'synthetic'
         AND f.method != 'synthetic_fill'
       ORDER BY o.ts DESC
       LIMIT 2000`
    )
    .all(horizonMs) as Array<{
    kind: string;
    netEdgeBps: number | null;
    predEdgeBps: number | null;
    spreadBps: number | null;
    feesBps: number | null;
    expectedSlippageBps: number | null;
    costBps: number | null;
    markoutBps: number | null;
  }>;

  const buckets: CalibrationBucket[] = BUCKETS.map((b) => ({
    label: b.label,
    count: 0,
    avgRealizedMarkoutBps: null
  }));

  const bucketSums: number[] = new Array(BUCKETS.length).fill(0);
  const bucketCounts: number[] = new Array(BUCKETS.length).fill(0);

  let sumPred = 0;
  let sumSpread = 0;
  let sumFees = 0;
  let sumSlippage = 0;
  let sumCost = 0;
  let sumNet = 0;
  let sumMarkout = 0;
  let markoutCount = 0;

  for (const row of rows) {
    const idx = bucketIndex(row.netEdgeBps);
    if (idx >= 0 && idx < BUCKETS.length && row.markoutBps != null && Number.isFinite(row.markoutBps)) {
      bucketSums[idx] = (bucketSums[idx] ?? 0) + row.markoutBps;
      bucketCounts[idx] = (bucketCounts[idx] ?? 0) + 1;
    }
    if (row.predEdgeBps != null && Number.isFinite(row.predEdgeBps)) sumPred += row.predEdgeBps;
    if (row.spreadBps != null && Number.isFinite(row.spreadBps)) sumSpread += row.spreadBps;
    if (row.feesBps != null && Number.isFinite(row.feesBps)) sumFees += row.feesBps;
    if (row.expectedSlippageBps != null && Number.isFinite(row.expectedSlippageBps)) sumSlippage += row.expectedSlippageBps;
    if (row.costBps != null && Number.isFinite(row.costBps)) sumCost += row.costBps;
    if (row.netEdgeBps != null && Number.isFinite(row.netEdgeBps)) sumNet += row.netEdgeBps;
    if (row.markoutBps != null && Number.isFinite(row.markoutBps)) {
      sumMarkout += row.markoutBps;
      markoutCount += 1;
    }
  }

  for (let i = 0; i < BUCKETS.length; i++) {
    const bc = bucketCounts[i] ?? 0;
    const bs = bucketSums[i] ?? 0;
    buckets[i] = {
      label: BUCKETS[i]!.label,
      count: bc,
      avgRealizedMarkoutBps: bc > 0 ? bs / bc : null
    };
  }

  const n = rows.length;
  const kind = kinds[0] ?? "unknown";

  return {
    kind,
    buckets,
    decomposition: {
      avgPredEdgeBps: n > 0 ? sumPred / n : null,
      avgSpreadBps: n > 0 ? sumSpread / n : null,
      avgFeesBps: n > 0 ? sumFees / n : null,
      avgExpectedSlippageBps: n > 0 ? sumSlippage / n : null,
      avgCostBps: n > 0 ? sumCost / n : null,
      avgNetEdgeBps: n > 0 ? sumNet / n : null,
      avgRealizedMarkoutBps: markoutCount > 0 ? sumMarkout / markoutCount : null,
      fillCount: n
    }
  };
}

export function getEdgeCalibration(horizonMs = 300000): EdgeCalibrationData {
  const { sqlite } = getDb();

  const taker = computeKindCalibration(sqlite, ["TAKER_BUY", "TAKER_SELL"], horizonMs);
  const maker = computeKindCalibration(sqlite, ["MAKER_BID", "MAKER_ASK"], horizonMs);

  const takerFills = taker.decomposition.fillCount;
  const makerFills = maker.decomposition.fillCount;

  const takerWinRow = sqlite
    .prepare(
      `SELECT COUNT(*) as wins
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       JOIN shadow_markouts m ON m.fill_id = f.id AND m.horizon_ms = ?
       WHERE o.kind IN ('TAKER_BUY','TAKER_SELL')
         AND f.method != 'synthetic_fill'
         AND m.markout_bps > 0`
    )
    .get(horizonMs) as { wins: number } | undefined;

  const takerTotalRow = sqlite
    .prepare(
      `SELECT COUNT(*) as cnt
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       JOIN shadow_markouts m ON m.fill_id = f.id AND m.horizon_ms = ?
       WHERE o.kind IN ('TAKER_BUY','TAKER_SELL')
         AND f.method != 'synthetic_fill'`
    )
    .get(horizonMs) as { cnt: number } | undefined;

  const makerOrdersRow = sqlite
    .prepare(
      `SELECT COUNT(*) as cnt FROM shadow_orders
       WHERE kind IN ('MAKER_BID','MAKER_ASK') AND (decision = 'SUBMIT' OR decision IS NULL)`
    )
    .get() as { cnt: number } | undefined;

  const takerTotal = takerTotalRow?.cnt ?? 0;
  const takerWinCount = takerWinRow?.wins ?? 0;
  const takerWinRate = takerTotal > 0 ? (takerWinCount / takerTotal) * 100 : 0;
  const makerOrdersTotal = makerOrdersRow?.cnt ?? 0;
  const makerFillRate = makerOrdersTotal > 0 ? (makerFills / makerOrdersTotal) * 100 : 0;

  const takerFillsTotalRow = sqlite
    .prepare(
      `SELECT COUNT(*) as c FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE o.kind IN ('TAKER_BUY','TAKER_SELL')`
    )
    .get() as { c: number } | undefined;
  const takerFillsWithMarkoutRow = sqlite
    .prepare(
      `SELECT COUNT(DISTINCT f.id) as c FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       JOIN shadow_markouts m ON m.fill_id = f.id AND m.horizon_ms = ?
       WHERE o.kind IN ('TAKER_BUY','TAKER_SELL')`
    )
    .get(horizonMs) as { c: number } | undefined;
  const takerFillsWithPredEdgeRow = sqlite
    .prepare(
      `SELECT COUNT(*) as c FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE o.kind IN ('TAKER_BUY','TAKER_SELL')
         AND o.pred_edge_bps IS NOT NULL
         AND (f.method IS NULL OR f.method != 'synthetic_fill')`
    )
    .get() as { c: number } | undefined;

  const diagnostics: { taker: CalibrationDiagnostics } = {
    taker: {
      fills_total: takerFillsTotalRow?.c ?? 0,
      fills_with_markout: takerFillsWithMarkoutRow?.c ?? 0,
      fills_with_pred_edge: takerFillsWithPredEdgeRow?.c ?? 0,
      fills_in_calibration: takerFills
    }
  };

  return {
    taker,
    maker,
    combined: {
      takerRealizedMarkoutBps: taker.decomposition.avgRealizedMarkoutBps,
      makerRealizedMarkoutBps: maker.decomposition.avgRealizedMarkoutBps,
      takerFills,
      makerFills,
      takerWinRate,
      makerFillRate
    },
    diagnostics
  };
}
