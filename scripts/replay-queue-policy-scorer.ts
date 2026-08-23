#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  discoverDbPath,
  numberArg,
  openReadOnlyDatabase,
  parseCliArgs,
  resolveRepoRoot,
  safeClose,
  stringArg
} from "./lib/db.js";

type MakerOrderRow = {
  orderId: number;
  ts: number;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  expectedCancelTs: number | null;
  queueAhead: number;
  netEdgeBps: number | null;
};

type TradeEvent = {
  ts: number;
  price: number;
  size: number;
  side: "BUY" | "SELL";
};

type FillOutcome = {
  fillSize: number;
  fillCount: number;
};

type MarkoutOutcome = {
  avgBps: number;
  count: number;
};

type SimulatedOrder = {
  orderId: number;
  netEdgeBps: number | null;
  predictedFillRatio: number;
  predictedFullFill: boolean;
  observedFillRatio: number;
  observedAnyFill: boolean;
  markoutBps: number | null;
};

type QueueScaleScore = {
  queueScale: number;
  brier: number;
  mae: number;
  fullFillPrecision: number;
  fullFillRecall: number;
};

type ThresholdScore = {
  thresholdBps: number;
  orders: number;
  avgNetEdgeBps: number;
  predictedFillRatio: number;
  observedAnyFillRate: number;
  markoutCount: number;
  markoutAvgBps: number | null;
  expectedEdgeProxyBps: number;
  realizedEdgeProxyBps: number | null;
};

type Report = {
  generatedAtIso: string;
  dbPath: string;
  windowHours: number;
  horizonMs: number;
  lookaheadSec: number;
  priceToleranceBps: number;
  queueScales: QueueScaleScore[];
  selectedQueueScale: number;
  totals: {
    orders: number;
    ordersWithMarkout: number;
    observedAnyFillRate: number;
  };
  thresholdScores: ThresholdScore[];
  recommendation: {
    queueScale: number;
    thresholdBps: number | null;
    reason: string;
  };
};

const clamp01 = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
};

const mean = (values: number[]): number => {
  if (!values.length) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
};

const parseNumberList = (raw: string, fallback: number[]): number[] => {
  const values = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((v) => Number.isFinite(v));
  return values.length ? values : fallback;
};

const parseTradePayload = (
  payloadJson: string
): { side: "BUY" | "SELL" | null; price: number | null; size: number | null } => {
  try {
    const parsed = JSON.parse(payloadJson) as { side?: unknown; price?: unknown; size?: unknown };
    const sideRaw = typeof parsed.side === "string" ? parsed.side.trim().toUpperCase() : "";
    const side = sideRaw === "BUY" || sideRaw === "SELL" ? (sideRaw as "BUY" | "SELL") : null;
    const price = typeof parsed.price === "number" && Number.isFinite(parsed.price) ? parsed.price : null;
    const size = typeof parsed.size === "number" && Number.isFinite(parsed.size) ? parsed.size : null;
    return { side, price, size };
  } catch {
    return { side: null, price: null, size: null };
  }
};

const lowerBoundTradeTs = (trades: TradeEvent[], ts: number): number => {
  let lo = 0;
  let hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trades[mid]!.ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const simulateOrderFill = (input: {
  order: MakerOrderRow;
  trades: TradeEvent[];
  queueScale: number;
  priceToleranceBps: number;
  lookaheadMs: number;
}): { predictedFillRatio: number; predictedFullFill: boolean } => {
  const { order, trades } = input;
  if (!trades.length) return { predictedFillRatio: 0, predictedFullFill: false };
  const tolPx = (input.priceToleranceBps / 10_000) * order.price;
  const queueAhead = Math.max(0, order.queueAhead) * Math.max(0.01, input.queueScale);
  const target = queueAhead + Math.max(0.000001, order.size);
  const endTs = Math.min(order.ts + input.lookaheadMs, order.expectedCancelTs ?? Number.MAX_SAFE_INTEGER);
  if (endTs <= order.ts) return { predictedFillRatio: 0, predictedFullFill: false };

  let matched = 0;
  const startIdx = lowerBoundTradeTs(trades, order.ts);
  for (let i = startIdx; i < trades.length; i += 1) {
    const trade = trades[i]!;
    if (trade.ts > endTs) break;
    const crosses =
      order.side === "BUY"
        ? trade.side === "SELL" && trade.price <= order.price + tolPx
        : trade.side === "BUY" && trade.price >= order.price - tolPx;
    if (!crosses) continue;
    matched += Math.max(0, trade.size);
    if (matched >= target) break;
  }

  const ratio = clamp01(matched / target);
  return {
    predictedFillRatio: ratio,
    predictedFullFill: ratio >= 1
  };
};

const computeQueueScaleScore = (orders: SimulatedOrder[], queueScale: number): QueueScaleScore => {
  const brierTerms: number[] = [];
  const maeTerms: number[] = [];
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (const order of orders) {
    const obs = order.observedFillRatio;
    const pred = order.predictedFillRatio;
    brierTerms.push((pred - obs) ** 2);
    maeTerms.push(Math.abs(pred - obs));
    if (order.predictedFullFill && order.observedAnyFill) tp += 1;
    else if (order.predictedFullFill && !order.observedAnyFill) fp += 1;
    else if (!order.predictedFullFill && order.observedAnyFill) fn += 1;
  }

  return {
    queueScale,
    brier: mean(brierTerms),
    mae: mean(maeTerms),
    fullFillPrecision: tp + fp > 0 ? tp / (tp + fp) : 0,
    fullFillRecall: tp + fn > 0 ? tp / (tp + fn) : 0
  };
};

function main(): void {
  const args = parseCliArgs();
  const dbPath = discoverDbPath(stringArg(args, "db", ""));
  const windowHours = Math.max(1, numberArg(args, "hours", 48));
  const horizonMs = Math.max(1000, Math.floor(numberArg(args, "horizon-ms", 300_000)));
  const lookaheadSec = Math.max(5, Math.floor(numberArg(args, "lookahead-sec", 30)));
  const priceToleranceBps = Math.max(0, numberArg(args, "price-tolerance-bps", 2));
  const minOrdersPerThreshold = Math.max(10, Math.floor(numberArg(args, "min-orders", 50)));
  const queueScales = parseNumberList(stringArg(args, "queue-scales", "0.25,0.5,1,1.5,2,3"), [1]).map((v) =>
    Math.max(0.01, v)
  );
  const thresholds = parseNumberList(
    stringArg(args, "thresholds", "0,0.5,1,2,3,5,8,10"),
    [0]
  ).sort((a, b) => a - b);
  const now = Date.now();
  const sinceTs = now - windowHours * 60 * 60 * 1000;

  const sqlite = openReadOnlyDatabase(dbPath);
  try {
    const makerOrders = sqlite
      .prepare(
        `SELECT
           o.id as orderId,
           o.ts as ts,
           o.token_id as tokenId,
           o.side as side,
           o.price as price,
           o.size as size,
           o.expected_cancel_ts as expectedCancelTs,
           CASE WHEN o.side = 'BUY' THEN COALESCE(o.bid_depth, 0) ELSE COALESCE(o.ask_depth, 0) END as queueAhead,
           o.net_edge_bps as netEdgeBps
         FROM shadow_orders o
         WHERE o.kind IN ('MAKER_BID', 'MAKER_ASK')
           AND o.execution_mode = 'SHADOW'
           AND o.ts >= ?
           AND o.price IS NOT NULL
           AND o.size IS NOT NULL
           AND o.size > 0
         ORDER BY o.ts ASC`
      )
      .all(sinceTs) as MakerOrderRow[];

    if (!makerOrders.length) {
      console.error("[replay-policy] no maker orders found in window");
      process.exit(1);
    }

    const fillMap = new Map<number, FillOutcome>();
    const fillRows = sqlite
      .prepare(
        `SELECT f.order_id as orderId, COUNT(*) as fillCount, COALESCE(SUM(f.size), 0) as fillSize
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE o.kind IN ('MAKER_BID', 'MAKER_ASK')
           AND o.execution_mode = 'SHADOW'
           AND o.ts >= ?
           AND f.method != 'synthetic_fill'
         GROUP BY f.order_id`
      )
      .all(sinceTs) as Array<{ orderId: number; fillCount: number; fillSize: number }>;
    for (const row of fillRows) {
      fillMap.set(row.orderId, {
        fillCount: Number.isFinite(row.fillCount) ? row.fillCount : 0,
        fillSize: Number.isFinite(row.fillSize) ? row.fillSize : 0
      });
    }

    const markoutMap = new Map<number, MarkoutOutcome>();
    const markoutRows = sqlite
      .prepare(
        `SELECT f.order_id as orderId, AVG(m.markout_bps) as avgBps, COUNT(*) as c
         FROM shadow_markouts m
         JOIN shadow_fills f ON f.id = m.fill_id
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE o.kind IN ('MAKER_BID', 'MAKER_ASK')
           AND o.execution_mode = 'SHADOW'
           AND o.ts >= ?
           AND f.method != 'synthetic_fill'
           AND m.horizon_ms = ?
           AND m.markout_bps IS NOT NULL
         GROUP BY f.order_id`
      )
      .all(sinceTs, horizonMs) as Array<{ orderId: number; avgBps: number; c: number }>;
    for (const row of markoutRows) {
      if (!Number.isFinite(row.avgBps)) continue;
      markoutMap.set(row.orderId, {
        avgBps: row.avgBps,
        count: row.c
      });
    }

    const tradeRows = sqlite
      .prepare(
        `SELECT recv_ts_ms as ts, token_id as tokenId, payload_json as payloadJson
         FROM clob_events
         WHERE msg_type = 'trade'
           AND recv_ts_ms >= ?
         ORDER BY recv_ts_ms ASC`
      )
      .all(Math.max(0, sinceTs - lookaheadSec * 1000)) as Array<{
      ts: number;
      tokenId: string;
      payloadJson: string;
    }>;
    const tradesByToken = new Map<string, TradeEvent[]>();
    for (const row of tradeRows) {
      const parsed = parseTradePayload(row.payloadJson);
      if (!parsed.side || !parsed.price || !parsed.size) continue;
      if (parsed.price <= 0 || parsed.size <= 0) continue;
      const arr = tradesByToken.get(row.tokenId) ?? [];
      arr.push({
        ts: row.ts,
        side: parsed.side,
        price: parsed.price,
        size: parsed.size
      });
      tradesByToken.set(row.tokenId, arr);
    }

    const lookaheadMs = lookaheadSec * 1000;
    const scaleResults: Array<{ scale: number; orders: SimulatedOrder[]; score: QueueScaleScore }> = [];
    for (const scale of queueScales) {
      const simulated: SimulatedOrder[] = makerOrders.map((order) => {
        const trades = tradesByToken.get(order.tokenId) ?? [];
        const sim = simulateOrderFill({
          order,
          trades,
          queueScale: scale,
          priceToleranceBps,
          lookaheadMs
        });
        const fills = fillMap.get(order.orderId);
        const observedFillRatio = clamp01((fills?.fillSize ?? 0) / Math.max(order.size, 0.000001));
        const observedAnyFill = (fills?.fillCount ?? 0) > 0;
        return {
          orderId: order.orderId,
          netEdgeBps: order.netEdgeBps,
          predictedFillRatio: sim.predictedFillRatio,
          predictedFullFill: sim.predictedFullFill,
          observedFillRatio,
          observedAnyFill,
          markoutBps: markoutMap.get(order.orderId)?.avgBps ?? null
        };
      });
      scaleResults.push({
        scale,
        orders: simulated,
        score: computeQueueScaleScore(simulated, scale)
      });
    }

    scaleResults.sort((a, b) => a.score.brier - b.score.brier);
    const best = scaleResults[0]!;
    const bestOrders = best.orders;

    const thresholdScores: ThresholdScore[] = thresholds.map((thresholdBps) => {
      const filtered = bestOrders.filter(
        (row) => row.netEdgeBps != null && Number.isFinite(row.netEdgeBps) && (row.netEdgeBps as number) >= thresholdBps
      );
      const orders = filtered.length;
      const avgNetEdgeBps = mean(filtered.map((row) => row.netEdgeBps as number));
      const predictedFillRatio = mean(filtered.map((row) => row.predictedFillRatio));
      const observedAnyFillRate = mean(filtered.map((row) => (row.observedAnyFill ? 1 : 0)));
      const marked = filtered.filter((row) => row.markoutBps != null && Number.isFinite(row.markoutBps));
      const markoutAvgBps = marked.length ? mean(marked.map((row) => row.markoutBps as number)) : null;
      const expectedEdgeProxyBps = avgNetEdgeBps * predictedFillRatio;
      const realizedEdgeProxyBps =
        markoutAvgBps != null ? observedAnyFillRate * markoutAvgBps : null;
      return {
        thresholdBps,
        orders,
        avgNetEdgeBps,
        predictedFillRatio,
        observedAnyFillRate,
        markoutCount: marked.length,
        markoutAvgBps,
        expectedEdgeProxyBps,
        realizedEdgeProxyBps
      };
    });

    const eligible = thresholdScores.filter((row) => row.orders >= minOrdersPerThreshold);
    eligible.sort((a, b) => {
      const aScore = a.realizedEdgeProxyBps ?? -Infinity;
      const bScore = b.realizedEdgeProxyBps ?? -Infinity;
      if (aScore === bScore) return b.expectedEdgeProxyBps - a.expectedEdgeProxyBps;
      return bScore - aScore;
    });
    const bestThreshold = eligible[0] ?? null;

    const report: Report = {
      generatedAtIso: new Date(now).toISOString(),
      dbPath,
      windowHours,
      horizonMs,
      lookaheadSec,
      priceToleranceBps,
      queueScales: scaleResults.map((row) => row.score),
      selectedQueueScale: best.scale,
      totals: {
        orders: bestOrders.length,
        ordersWithMarkout: bestOrders.filter((row) => row.markoutBps != null).length,
        observedAnyFillRate: mean(bestOrders.map((row) => (row.observedAnyFill ? 1 : 0)))
      },
      thresholdScores,
      recommendation: {
        queueScale: best.scale,
        thresholdBps: bestThreshold?.thresholdBps ?? null,
        reason: bestThreshold
          ? `best realized edge proxy with min_orders=${minOrdersPerThreshold}`
          : `no threshold met min_orders=${minOrdersPerThreshold}; use diagnostics only`
      }
    };

    const repoRoot = resolveRepoRoot();
    const runId = new Date(now).toISOString().replace(/[:.]/g, "-");
    const outDir = path.join(repoRoot, "data", "replay-policy");
    mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${runId}.json`);
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

    console.log(`[replay-policy] db=${dbPath}`);
    console.log(`[replay-policy] orders=${report.totals.orders} markouts=${report.totals.ordersWithMarkout}`);
    console.log(
      `[replay-policy] selected_queue_scale=${report.selectedQueueScale} brier=${report.queueScales[0]?.brier.toFixed(6) ?? "n/a"}`
    );
    if (report.recommendation.thresholdBps != null) {
      console.log(`[replay-policy] recommended_threshold_bps=${report.recommendation.thresholdBps}`);
    } else {
      console.log("[replay-policy] no threshold recommendation (insufficient sample)");
    }
    console.log(`[replay-policy] wrote=${outPath}`);
  } finally {
    safeClose(sqlite);
  }
}

main();
