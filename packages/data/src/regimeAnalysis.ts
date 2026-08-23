import type Database from "better-sqlite3";
import { binValue, computeQuantileEdges, decodeState, encodeState, lookupStateAt } from "./markovRegime";

export type RegimeConfig = {
  sinceTs: number;
  horizonMs: number;
  bins: number;
  stepMs: number;
  sampleLimit: number;
  features: string[];
  /** Winsorization clip for markout std/se calculations; default 250 bps. */
  winsorClipBps?: number;
};

export type MarkovRegimeReport = {
  config: RegimeConfig;
  edges: Record<string, number[]>;
  states: Record<
    string,
    {
      label: string;
      count: number;
      markout: {
        state: number;
        count: number;
        winRate: number;
        avgBps: number;
        wavgBps: number;
        notional: number;
      } | null;
    }
  >;
  transitions: Record<string, { total: number; to: Record<string, number> }>;
};

export type StrategyRegimeRow = {
  state: number;
  kind: string;
  walletId: number;
  /** Fills with attributed markouts in this (state, kind, wallet). */
  count: number;
  /** Alias of count to make denominator intent explicit in downstream consumers. */
  markoutCount: number;
  /** Total submitted orders in this (state, kind, wallet). */
  orderCount: number;
  /** Filled orders in this (state, kind, wallet). */
  filledOrderCount: number;
  winRate: number;
  avgBps: number;
  /** null when no markouts (order-only combo); UI shows —. Gate treats as no evidence. */
  wavgBps: number | null;
  /** Winsorized markout sample std-dev (bps). */
  markoutStdBps: number | null;
  /** Winsorized markout standard error (bps). */
  markoutSeBps: number | null;
  notional: number;
  fillRate: number | null;
  avgTimeInBookMs: number | null;
};

export type StrategyRegimeReport = {
  config: RegimeConfig;
  edges: Record<string, number[]>;
  rows: StrategyRegimeRow[];
  stateLabels: Record<string, string>;
};

type FeatureRow = {
  ts: number;
  tokenId: string;
  spread: number | null;
  bidDepthTop: number | null;
  askDepthTop: number | null;
  obi: number | null;
  vol30m: number | null;
  micropriceMinusMid: number | null;
};

type MarkoutRow = {
  ts: number;
  markoutBps: number | null;
  midAtFill: number | null;
  price: number | null;
  size: number | null;
  tokenId: string;
  kind: string;
  walletId: number | null;
  orderId: number;
  stateId: number | null;
};

type OrderRow = {
  id: number;
  ts: number;
  tokenId: string;
  kind: string;
  walletId: number | null;
  stateId: number | null;
};

type Agg = {
  count: number;
  win: number;
  sumBps: number;
  sumWeightedBps: number;
  sumNotional: number;
  sumWinsorBps: number;
  sumSqWinsorBps: number;
};

type OrderAgg = {
  orders: number;
  filledOrders: number;
  sumTimeInBookMs: number;
  filledCount: number;
};

// Entry actions that the regime gate can actually allow/deny.
// We intentionally exclude maintenance kinds to keep research
// and gating evidence focused on actionable entry decisions.
const ACTIONABLE_ORDER_KINDS_SQL =
  "('MAKER_BID','MAKER_ASK','TAKER_BUY','TAKER_SELL')";

export type RegimeBase = {
  edgesByFeature: Map<string, number[]>;
  stateTimelines: Map<string, Array<{ ts: number; state: number }>>;
  tokenIds: string[];
  featuresUsed: string[];
  featureRowsScanned: number;
};

const metricExtractors: Record<string, (row: FeatureRow) => number | null> = {
  spread: (row) => row.spread,
  depth: (row) =>
    Number.isFinite(row.bidDepthTop ?? NaN) && Number.isFinite(row.askDepthTop ?? NaN)
      ? (row.bidDepthTop ?? 0) + (row.askDepthTop ?? 0)
      : null,
  obi: (row) => row.obi,
  vol: (row) => row.vol30m,
  micro: (row) => row.micropriceMinusMid
};

const chunk = <T,>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
};

const readFeatures = (sqlite: Database.Database, sinceTs: number, ids: string[]): FeatureRow[] => {
  const placeholders = ids.map(() => "?").join(",");
  return sqlite
    .prepare(
      `SELECT ts, token_id as tokenId, spread, bid_depth_top as bidDepthTop, ask_depth_top as askDepthTop,
              obi, vol30m, microprice_minus_mid as micropriceMinusMid
       FROM features
       WHERE ts >= ? AND token_id IN (${placeholders})
       ORDER BY token_id, ts`
    )
    .all(sinceTs, ...ids) as FeatureRow[];
};

export const buildRegimeBase = (sqlite: Database.Database, config: RegimeConfig): RegimeBase => {
  const validFeatures = config.features.filter((f) => metricExtractors[f]);
  if (!validFeatures.length) {
    throw new Error("No valid features provided for regime analysis.");
  }

  const tokenRows = sqlite
    .prepare(
      `SELECT DISTINCT o.token_id as tokenId
       FROM shadow_orders o
       WHERE o.ts >= ?
         AND o.kind IN ${ACTIONABLE_ORDER_KINDS_SQL}`
    )
    .all(config.sinceTs) as Array<{ tokenId: string }>;

  let tokenIds = tokenRows.map((r) => r.tokenId);
  if (!tokenIds.length) {
    const featureTokenRows = sqlite
      .prepare("SELECT DISTINCT token_id as tokenId FROM features WHERE ts >= ? LIMIT 500")
      .all(config.sinceTs) as Array<{ tokenId: string }>;
    tokenIds = featureTokenRows.map((r) => r.tokenId);
  }

  const samples = new Map<string, number[]>();
  for (const name of validFeatures) samples.set(name, []);

  let featureRowsScanned = 0;
  for (const ids of chunk(tokenIds, 400)) {
    const rows = readFeatures(sqlite, config.sinceTs, ids);
    for (const row of rows) {
      featureRowsScanned += 1;
      let ok = true;
      const vals: Record<string, number> = {};
      for (const name of validFeatures) {
        const value = metricExtractors[name]?.(row);
        if (!Number.isFinite(value ?? NaN)) {
          ok = false;
          break;
        }
        vals[name] = value as number;
      }
      if (!ok) continue;
      for (const name of validFeatures) {
        const v = vals[name];
        if (v == null || !Number.isFinite(v)) continue;
        const arr = samples.get(name) ?? [];
        if (arr.length < config.sampleLimit) {
          arr.push(v);
          samples.set(name, arr);
        }
      }
    }
  }

  const edgesByFeature = new Map<string, number[]>();
  for (const name of validFeatures) {
    const values = samples.get(name) ?? [];
    edgesByFeature.set(name, computeQuantileEdges(values, config.bins));
  }

  const stateTimelines = new Map<string, Array<{ ts: number; state: number }>>();
  const lastTsByToken = new Map<string, number>();

  for (const ids of chunk(tokenIds, 400)) {
    const rows = readFeatures(sqlite, config.sinceTs, ids);
    for (const row of rows) {
      const metrics: number[] = [];
      let ok = true;
      for (const name of validFeatures) {
        const value = metricExtractors[name]?.(row);
        if (!Number.isFinite(value ?? NaN)) {
          ok = false;
          break;
        }
        const edges = edgesByFeature.get(name) ?? [];
        metrics.push(binValue(value as number, edges));
      }
      if (!ok) continue;

      const lastTs = lastTsByToken.get(row.tokenId);
      if (lastTs != null && row.ts - lastTs < config.stepMs) {
        continue;
      }

      const state = encodeState(metrics, config.bins);
      lastTsByToken.set(row.tokenId, row.ts);
      const timeline = stateTimelines.get(row.tokenId) ?? [];
      timeline.push({ ts: row.ts, state });
      stateTimelines.set(row.tokenId, timeline);
    }
  }

  return { edgesByFeature, stateTimelines, tokenIds, featuresUsed: validFeatures, featureRowsScanned };
};

const stateLabel = (features: string[], bins: number, stateId: number): string => {
  const binsArr = decodeState(stateId, bins, features.length);
  return binsArr.map((b, i) => `${features[i]}:${b}`).join(" ");
};

export const computeMarkovRegimeReport = (
  sqlite: Database.Database,
  config: RegimeConfig
): MarkovRegimeReport => {
  const base = buildRegimeBase(sqlite, config);
  const { edgesByFeature, stateTimelines, featuresUsed } = base;

  const stateCounts = new Map<number, number>();
  const transitions = new Map<number, Map<number, number>>();
  for (const timeline of stateTimelines.values()) {
    for (let i = 0; i < timeline.length; i += 1) {
      const cur = timeline[i];
      if (!cur) continue;
      stateCounts.set(cur.state, (stateCounts.get(cur.state) ?? 0) + 1);
      if (i > 0) {
        const prev = timeline[i - 1]?.state;
        if (prev == null) continue;
        const row = transitions.get(prev) ?? new Map<number, number>();
        row.set(cur.state, (row.get(cur.state) ?? 0) + 1);
        transitions.set(prev, row);
      }
    }
  }

  const markoutRows = sqlite
    .prepare(
      `SELECT m.ts as ts, m.markout_bps as markoutBps, m.mid_at_fill as midAtFill,
              f.price as price, f.size as size,
              o.token_id as tokenId, o.kind as kind, o.wallet_id as walletId, o.id as orderId, o.state_id as stateId
       FROM shadow_markouts m
       JOIN shadow_fills f ON f.id = m.fill_id
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE m.horizon_ms = ? AND m.ts >= ?
         AND o.kind IN ${ACTIONABLE_ORDER_KINDS_SQL}`
    )
    .all(config.horizonMs, config.sinceTs) as MarkoutRow[];

  const byState = new Map<number, Agg>();

  const winsorClip = Math.max(0, Number(config.winsorClipBps ?? 250));
  const winsorizeBps = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    if (winsorClip <= 0) return value;
    if (value > winsorClip) return winsorClip;
    if (value < -winsorClip) return -winsorClip;
    return value;
  };

  const addAgg = (agg: Agg | undefined, markoutBps: number, notional: number): Agg => {
    const next = agg ?? {
      count: 0,
      win: 0,
      sumBps: 0,
      sumWeightedBps: 0,
      sumNotional: 0,
      sumWinsorBps: 0,
      sumSqWinsorBps: 0
    };
    const clipped = winsorizeBps(markoutBps);
    next.count += 1;
    if (markoutBps >= 0) next.win += 1;
    next.sumBps += markoutBps;
    next.sumWeightedBps += markoutBps * notional;
    next.sumNotional += notional;
    next.sumWinsorBps += clipped;
    next.sumSqWinsorBps += clipped * clipped;
    return next;
  };

  for (const row of markoutRows) {
    if (!Number.isFinite(row.markoutBps ?? NaN)) continue;
    if (!Number.isFinite(row.size ?? NaN) || (row.size ?? 0) <= 0) continue;
    const mid = row.midAtFill ?? row.price ?? 0;
    if (!Number.isFinite(mid) || mid <= 0) continue;
    const notional = mid * (row.size ?? 0);

    let state: number | null = Number.isFinite(row.stateId ?? NaN) ? (row.stateId as number) : null;
    if (state == null) {
      const timeline = stateTimelines.get(row.tokenId);
      state = timeline ? lookupStateAt(timeline, row.ts) : null;
    }
    if (state == null) continue;
    byState.set(state, addAgg(byState.get(state), row.markoutBps as number, notional));
  }

  const transitionsJson: Record<string, { total: number; to: Record<string, number> }> = {};
  for (const [from, row] of transitions) {
    const total = Array.from(row.values()).reduce((a, b) => a + b, 0);
    transitionsJson[String(from)] = {
      total,
      to: Object.fromEntries(Array.from(row.entries()).map(([to, count]) => [String(to), count]))
    };
  }

  const statesJson: Record<string, { label: string; count: number; markout: any }> = {};
  for (const [state, count] of stateCounts) {
    const agg = byState.get(state);
    statesJson[String(state)] = {
      label: stateLabel(featuresUsed, config.bins, state),
      count,
      markout: agg
        ? {
            state,
            count: agg.count,
            winRate: agg.count > 0 ? agg.win / agg.count : 0,
            avgBps: agg.count > 0 ? agg.sumBps / agg.count : 0,
            wavgBps: agg.sumNotional > 0 ? agg.sumWeightedBps / agg.sumNotional : 0,
            notional: agg.sumNotional
          }
        : null
    };
  }

  return {
    config,
    edges: Object.fromEntries(Array.from(edgesByFeature.entries())),
    states: statesJson,
    transitions: transitionsJson
  };
};

export const computeStrategyRegimeReport = (
  sqlite: Database.Database,
  config: RegimeConfig
): StrategyRegimeReport => {
  const base = buildRegimeBase(sqlite, config);
  const { edgesByFeature, stateTimelines, featuresUsed } = base;

  const markoutRows = sqlite
    .prepare(
      `SELECT m.ts as ts, m.markout_bps as markoutBps, m.mid_at_fill as midAtFill,
              f.price as price, f.size as size,
              o.token_id as tokenId, o.kind as kind, o.wallet_id as walletId, o.id as orderId, o.state_id as stateId
       FROM shadow_markouts m
       JOIN shadow_fills f ON f.id = m.fill_id
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE m.horizon_ms = ? AND m.ts >= ?
         AND o.kind IN ${ACTIONABLE_ORDER_KINDS_SQL}`
    )
    .all(config.horizonMs, config.sinceTs) as MarkoutRow[];

  const orderRows = sqlite
    .prepare(
      `SELECT id, ts, token_id as tokenId, kind, wallet_id as walletId, state_id as stateId
       FROM shadow_orders
       WHERE ts >= ?
         AND kind IN ${ACTIONABLE_ORDER_KINDS_SQL}`
    )
    .all(config.sinceTs) as OrderRow[];

  const fillMinTsByOrder = sqlite
    .prepare(
      `SELECT f.order_id as orderId, MIN(f.ts) as firstFillTs
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE f.ts >= ?
         AND o.kind IN ${ACTIONABLE_ORDER_KINDS_SQL}
       GROUP BY f.order_id`
    )
    .all(config.sinceTs) as Array<{ orderId: number; firstFillTs: number | null }>;

  const firstFillMap = new Map<number, number>();
  for (const row of fillMinTsByOrder) {
    if (row.firstFillTs != null) firstFillMap.set(row.orderId, row.firstFillTs);
  }

  const byStateKindWallet = new Map<string, Agg>();
  const byStateOrder = new Map<string, OrderAgg>();

  const winsorClip = Math.max(0, Number(config.winsorClipBps ?? 250));
  const winsorizeBps = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    if (winsorClip <= 0) return value;
    if (value > winsorClip) return winsorClip;
    if (value < -winsorClip) return -winsorClip;
    return value;
  };

  const addAgg = (agg: Agg | undefined, markoutBps: number, notional: number): Agg => {
    const next = agg ?? {
      count: 0,
      win: 0,
      sumBps: 0,
      sumWeightedBps: 0,
      sumNotional: 0,
      sumWinsorBps: 0,
      sumSqWinsorBps: 0
    };
    const clipped = winsorizeBps(markoutBps);
    next.count += 1;
    if (markoutBps >= 0) next.win += 1;
    next.sumBps += markoutBps;
    next.sumWeightedBps += markoutBps * notional;
    next.sumNotional += notional;
    next.sumWinsorBps += clipped;
    next.sumSqWinsorBps += clipped * clipped;
    return next;
  };

  const addOrderAgg = (agg: OrderAgg | undefined, filled: boolean, timeInBookMs: number | null): OrderAgg => {
    const next = agg ?? { orders: 0, filledOrders: 0, sumTimeInBookMs: 0, filledCount: 0 };
    next.orders += 1;
    if (filled) {
      next.filledOrders += 1;
      if (timeInBookMs != null && Number.isFinite(timeInBookMs)) {
        next.sumTimeInBookMs += timeInBookMs;
        next.filledCount += 1;
      }
    }
    return next;
  };

  for (const row of markoutRows) {
    if (!Number.isFinite(row.markoutBps ?? NaN)) continue;
    if (!Number.isFinite(row.size ?? NaN) || (row.size ?? 0) <= 0) continue;
    const mid = row.midAtFill ?? row.price ?? 0;
    if (!Number.isFinite(mid) || mid <= 0) continue;
    const notional = mid * (row.size ?? 0);

    let state: number | null = Number.isFinite(row.stateId ?? NaN) ? (row.stateId as number) : null;
    if (state == null) {
      const timeline = stateTimelines.get(row.tokenId);
      state = timeline ? lookupStateAt(timeline, row.ts) : null;
    }
    if (state == null) continue;

    const key = `${state}|${row.kind}|${row.walletId ?? -1}`;
    byStateKindWallet.set(key, addAgg(byStateKindWallet.get(key), row.markoutBps as number, notional));
  }

  for (const row of orderRows) {
    let state: number | null = Number.isFinite(row.stateId ?? NaN) ? (row.stateId as number) : null;
    if (state == null) {
      const timeline = stateTimelines.get(row.tokenId);
      state = timeline ? lookupStateAt(timeline, row.ts) : null;
    }
    if (state == null) continue;
    const firstFillTs = firstFillMap.get(row.id) ?? null;
    const filled = firstFillTs != null;
    const timeInBook = filled ? firstFillTs! - row.ts : null;
    const key = `${state}|${row.kind}|${row.walletId ?? -1}`;
    byStateOrder.set(key, addOrderAgg(byStateOrder.get(key), filled, timeInBook));
  }

  const allKeys = new Set<string>([...byStateKindWallet.keys(), ...byStateOrder.keys()]);
  const rows: StrategyRegimeRow[] = Array.from(allKeys).map((key) => {
    const parts = key.split("|");
    const stateStr = parts[0];
    const kind = parts[1];
    const walletStr = parts[2];
    if (kind == null) throw new Error(`Invalid regime key format: ${key}`);
    const state = Number(stateStr);
    const walletId = Number(walletStr);
    const agg = byStateKindWallet.get(key);
    const orderAgg = byStateOrder.get(key);
    const fillRate = orderAgg && orderAgg.orders > 0 ? orderAgg.filledOrders / orderAgg.orders : null;
    const avgTimeInBook =
      orderAgg && orderAgg.filledCount > 0 ? orderAgg.sumTimeInBookMs / orderAgg.filledCount : null;
    const orderCount = orderAgg?.orders ?? 0;
    const filledOrderCount = orderAgg?.filledOrders ?? 0;
    if (agg) {
      const wavg = agg.sumNotional > 0 ? agg.sumWeightedBps / agg.sumNotional : 0;
      const avg = agg.count > 0 ? agg.sumBps / agg.count : 0;
      const win = agg.count > 0 ? agg.win / agg.count : 0;
      let std = 0;
      if (agg.count > 1) {
        const n = agg.count;
        const numer = agg.sumSqWinsorBps - ((agg.sumWinsorBps * agg.sumWinsorBps) / n);
        std = Math.sqrt(Math.max(0, numer / (n - 1)));
      }
      const se = agg.count > 0 ? std / Math.sqrt(agg.count) : 0;
      return {
        state,
        kind,
        walletId,
        count: agg.count,
        markoutCount: agg.count,
        orderCount,
        filledOrderCount,
        winRate: win,
        avgBps: avg,
        wavgBps: wavg,
        markoutStdBps: std,
        markoutSeBps: se,
        notional: agg.sumNotional,
        fillRate,
        avgTimeInBookMs: avgTimeInBook
      };
    }
    return {
      state,
      kind,
      walletId,
      count: 0,
      markoutCount: 0,
      orderCount,
      filledOrderCount,
      winRate: 0,
      avgBps: 0,
      wavgBps: null,
      markoutStdBps: null,
      markoutSeBps: null,
      notional: 0,
      fillRate,
      avgTimeInBookMs: avgTimeInBook
    };
  });

  rows.sort((a, b) => (b.wavgBps ?? -Infinity) - (a.wavgBps ?? -Infinity));

  const stateLabels: Record<string, string> = {};
  for (const row of rows) {
    if (stateLabels[String(row.state)]) continue;
    stateLabels[String(row.state)] = stateLabel(featuresUsed, config.bins, row.state);
  }

  return {
    config,
    edges: Object.fromEntries(Array.from(edgesByFeature.entries())),
    rows,
    stateLabels
  };
};
