import { getDb } from "./db";
import { getSignalHorizons } from "./horizons";
import { queryCache, cacheKeys } from "./query-cache";
import { sql, desc, eq, markets, alerts } from "@polysignal/storage";
export type UniverseRow = {
  tokenId: string;
  marketId: string;
  slug: string | null;
  question: string | null;
  outcome: string | null;
  volume: number | null; // Market volume (USD)
  mid: number | null;
  spread: number | null;
  obi: number | null;
  micropriceMinusMid: number | null;
  accel1m: number | null;
  skew30m: number | null;
  entropy30m: number | null;
  vol30m: number | null;
  ts: number | null; // Last update timestamp
  signals: Record<number, string | null>; // Map of horizon_sec -> signal
};


export type OpportunityRow = {
  tokenId: string;
  marketId: string | null;
  slug: string | null;
  question: string | null;
  outcome: string | null;
  ts: number;
  horizonSec: number;
  signal: string;
  deltaHat: number;
  confidence: number;
  buffer: number;
  reasons: string[];
  mid: number | null;
  spread: number | null;
  obi: number | null;
  micropriceMinusMid: number | null;
  accel1m: number | null;
  skew30m: number | null;
  entropy30m: number | null;
  vol30m: number | null;
  edge: number;
  score: number;
  signal5m: string | null;
  signal15m: string | null;
  signal30m: string | null;
};

type ShadowFillRow = {
  walletId: number;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  ts: number;
};

const tableExists = (sqlite: ReturnType<typeof getDb>["sqlite"], name: string): boolean => {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return row?.name === name;
};

type ShadowPnLState = {
  walletId: number;
  tokenId: string;
  position: number;
  avgEntry: number;
  realized: number;
  lastTs: number;
};

const applyShadowFill = (state: ShadowPnLState, fill: ShadowFillRow): ShadowPnLState => {
  if (!Number.isFinite(fill.price) || !Number.isFinite(fill.size)) return state;
  const delta = fill.side === "BUY" ? fill.size : -fill.size;
  const nextPos = state.position + delta;

  if (state.position === 0) {
    return {
      ...state,
      position: nextPos,
      avgEntry: fill.price,
      lastTs: Math.max(state.lastTs, fill.ts)
    };
  }

  const sameDirection = (state.position > 0 && delta > 0) || (state.position < 0 && delta < 0);
  if (sameDirection) {
    const totalSize = Math.abs(state.position) + Math.abs(delta);
    const weightedAvg =
      (Math.abs(state.position) * state.avgEntry + Math.abs(delta) * fill.price) / totalSize;
    return {
      ...state,
      position: nextPos,
      avgEntry: weightedAvg,
      lastTs: Math.max(state.lastTs, fill.ts)
    };
  }

  const closingSize = Math.min(Math.abs(state.position), Math.abs(delta));
  const pnlPerUnit = state.position > 0 ? fill.price - state.avgEntry : state.avgEntry - fill.price;
  const realized = state.realized + pnlPerUnit * closingSize;
  const remaining = nextPos;

  if (remaining === 0) {
    return {
      ...state,
      position: 0,
      avgEntry: 0,
      realized,
      lastTs: Math.max(state.lastTs, fill.ts)
    };
  }

  return {
    ...state,
    position: remaining,
    avgEntry: fill.price,
    realized,
    lastTs: Math.max(state.lastTs, fill.ts)
  };
};

const computeShadowUnrealized = (state: ShadowPnLState, mark: number): number => {
  if (!Number.isFinite(mark) || mark <= 0) return 0;
  if (state.position === 0) return 0;
  return state.position > 0
    ? (mark - state.avgEntry) * state.position
    : (state.avgEntry - mark) * Math.abs(state.position);
};

const loadShadowMakerStates = (sqlite: ReturnType<typeof getDb>["sqlite"]) => {
  const fills = sqlite.prepare(
    `SELECT
       o.wallet_id as walletId,
       o.token_id as tokenId,
       o.side as side,
       f.price as price,
       f.size as size,
       f.ts as ts
     FROM shadow_fills f
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE o.kind IN ('MAKER_BID','MAKER_ASK','INVENTORY_REBALANCE')
       AND f.method != 'synthetic_fill'
     ORDER BY f.ts ASC`
  ).all() as ShadowFillRow[];

  const states = new Map<string, ShadowPnLState>();
  for (const fill of fills) {
    if (!Number.isFinite(fill.price) || !Number.isFinite(fill.size)) continue;
    const key = `${fill.walletId}:${fill.tokenId}`;
    const state =
      states.get(key) ?? {
        walletId: fill.walletId,
        tokenId: fill.tokenId,
        position: 0,
        avgEntry: 0,
        realized: 0,
        lastTs: fill.ts
      };
    states.set(key, applyShadowFill(state, fill));
  }

  return states;
};


export type EvidenceEventType =
  | "SIGNAL_CREATED"
  | "PRICE_UPDATE"
  | "ORDERBOOK_IMBALANCE"
  | "EXECUTION"
  | "CONFIRMATION"
  | "ORDER_SUBMITTED"
  | "FILLED"
  | "CANCELED"
  | "MARKOUT"
  | "EDGE_FAIL"
  | "INVENTORY_FAIL"
  | "FLOW_GATE"
  | "REGIME_BLOCK";

export type EvidenceEvent = {
  id: string;
  type: EvidenceEventType;
  ts: number;
  title: string;
  details: string;
  metadata?: Record<string, unknown>;
};

export type DecisionEdge = {
  decisionId: number;
  ts: number;
  tokenId: string;
  walletId: number | null;
  kind: string;
  strategyLane: string | null;
  decisionGroupId: string | null;
  decision: string;
  decisionReason: string | null;
  predEdgeBps: number | null;
  costBps: number | null;
  netEdgeBps: number | null;
  spreadBps: number | null;
  size: number | null;
  ordersCount: number;
  fillsCount: number;
  fillNotional: number;
  markout1mBpsAvg: number | null;
  markout5mBpsAvg: number | null;
};

function queryDecisionEdges(
  sqlite: ReturnType<typeof getDb>["sqlite"],
  options: {
    limit: number;
    tokenId?: string | null;
    sinceTs?: number;
  }
): DecisionEdge[] {
  if (!tableExists(sqlite, "decision_log")) return [];
  const predicates: string[] = [];
  const params: Array<number | string> = [];
  if (options.tokenId) {
    predicates.push("d.token_id = ?");
    params.push(options.tokenId);
  }
  if (options.sinceTs != null) {
    predicates.push("d.ts >= ?");
    params.push(options.sinceTs);
  }
  const whereClause = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
  const rows = sqlite
    .prepare(
      `WITH order_agg AS (
         SELECT decision_group_id as decisionGroupId,
                COUNT(*) as ordersCount
         FROM shadow_orders
         WHERE decision_group_id IS NOT NULL
         GROUP BY decision_group_id
       ),
       fill_agg AS (
         SELECT o.decision_group_id as decisionGroupId,
                COUNT(DISTINCT f.id) as fillsCount,
                COALESCE(SUM(CASE WHEN f.price IS NOT NULL AND f.size IS NOT NULL THEN f.price * f.size ELSE 0 END), 0) as fillNotional
         FROM shadow_orders o
         LEFT JOIN shadow_fills f
           ON f.order_id = o.id
          AND (f.method IS NULL OR f.method != 'synthetic_fill')
         WHERE o.decision_group_id IS NOT NULL
         GROUP BY o.decision_group_id
       ),
       markout_agg AS (
         SELECT o.decision_group_id as decisionGroupId,
                AVG(CASE WHEN m.horizon_ms = 60000 THEN m.markout_bps END) as markout1mBpsAvg,
                AVG(CASE WHEN m.horizon_ms = 300000 THEN m.markout_bps END) as markout5mBpsAvg
         FROM shadow_orders o
         JOIN shadow_fills f
           ON f.order_id = o.id
          AND (f.method IS NULL OR f.method != 'synthetic_fill')
         JOIN shadow_markouts m ON m.fill_id = f.id
         WHERE o.decision_group_id IS NOT NULL
         GROUP BY o.decision_group_id
       )
       SELECT
         d.id as decisionId,
         d.ts as ts,
         d.token_id as tokenId,
         d.wallet_id as walletId,
         d.kind as kind,
         d.strategy_lane as strategyLane,
         d.decision_group_id as decisionGroupId,
         d.decision as decision,
         d.decision_reason as decisionReason,
         d.pred_edge_bps as predEdgeBps,
         d.cost_bps as costBps,
         d.net_edge_bps as netEdgeBps,
         d.spread_bps as spreadBps,
         d.size as size,
         COALESCE(oa.ordersCount, 0) as ordersCount,
         COALESCE(fa.fillsCount, 0) as fillsCount,
         COALESCE(fa.fillNotional, 0) as fillNotional,
         ma.markout1mBpsAvg as markout1mBpsAvg,
         ma.markout5mBpsAvg as markout5mBpsAvg
       FROM decision_log d
       LEFT JOIN order_agg oa ON oa.decisionGroupId = d.decision_group_id
       LEFT JOIN fill_agg fa ON fa.decisionGroupId = d.decision_group_id
       LEFT JOIN markout_agg ma ON ma.decisionGroupId = d.decision_group_id
       ${whereClause}
       ORDER BY d.ts DESC
       LIMIT ?`
    )
    .all(...params, Math.max(1, options.limit)) as DecisionEdge[];
  return rows;
}

export function getUniverseSnapshot(limit = 200, options?: { onlyWithSignals?: boolean }): UniverseRow[] {
  const cacheKey = cacheKeys.universe(limit, options?.onlyWithSignals);
  const cached = queryCache.get<UniverseRow[]>(cacheKey);
  if (cached) return cached;

  const { sqlite } = getDb();
  const horizons = getSignalHorizons();

  // Fetch base data - include market volume for filtering/sorting
  const baseSql = `
        SELECT
          t.id as tokenId,
          t.market_id as marketId,
          m.slug as slug,
          m.question as question,
          t.outcome as outcome,
          m.volume as volume,
          lf.mid as mid,
          lf.spread as spread,
          lf.obi as obi,
          lf.microprice_minus_mid as micropriceMinusMid,
          lf.accel_1m as accel1m,
          lf.skew_30m as skew30m,
          lf.entropy_30m as entropy30m,
          lf.vol30m as vol30m,
          lf.ts as ts
        FROM tokens t
        JOIN markets m ON m.id = t.market_id
        JOIN latest_features lf ON lf.token_id = t.id
        WHERE lf.mid IS NOT NULL
        ORDER BY COALESCE(m.volume, 0) DESC
        LIMIT ?
      `;

  const baseRows = sqlite.prepare(baseSql).all(limit) as (Omit<UniverseRow, 'signals'> & { ts: number | null })[];

  if (baseRows.length === 0 || horizons.length === 0) {
    return baseRows.map(row => ({
      ...row,
      signals: {} as Record<number, string | null>
    }));
  }

  const latestDecisionByToken = new Map<string, "BUY" | "SELL">();
  if (tableExists(sqlite, "decision_log")) {
    const tokenIds = baseRows.map((r) => r.tokenId);
    const placeholders = tokenIds.map(() => "?").join(",");
    if (placeholders.length > 0) {
      const rows = sqlite
        .prepare(
          `SELECT token_id as tokenId, kind
           FROM decision_log
           WHERE decision = 'SUBMIT'
             AND token_id IN (${placeholders})
             AND kind IN ('TAKER_BUY','TAKER_SELL','MAKER_BID','MAKER_ASK')
           ORDER BY ts DESC`
        )
        .all(...tokenIds) as Array<{ tokenId: string; kind: string }>;
      for (const row of rows) {
        if (latestDecisionByToken.has(row.tokenId)) continue;
        const side = row.kind.includes("BUY") || row.kind.includes("BID") ? "BUY" : "SELL";
        latestDecisionByToken.set(row.tokenId, side);
      }
    }
  }

  const merged = baseRows.map(row => {
    const latestSide = latestDecisionByToken.get(row.tokenId) ?? null;
    const signals: Record<number, string | null> = {};
    for (const horizon of horizons) {
      signals[horizon] = latestSide;
    }
    return {
      ...row,
      signals
    };
  });

  // Filter out tokens without signals if requested
  const filtered = options?.onlyWithSignals
    ? merged.filter(row => {
      return horizons.every(h => row.signals[h] != null);
    })
    : merged;

  // Sort: tokens with BUY/SELL signals first, then by volume
  // Count how many actionable (BUY/SELL) signals each token has (HOLD doesn't count)
  const sorted = filtered.sort((a, b) => {
    const aSignalCount = horizons.filter(h => {
      const sig = a.signals[h];
      return sig != null && sig !== 'HOLD';
    }).length;
    const bSignalCount = horizons.filter(h => {
      const sig = b.signals[h];
      return sig != null && sig !== 'HOLD';
    }).length;

    // First sort by actionable signal count (descending)
    if (aSignalCount !== bSignalCount) {
      return bSignalCount - aSignalCount;
    }

    // Then by volume (descending)
    const aVolume = a.volume ?? 0;
    const bVolume = b.volume ?? 0;
    return bVolume - aVolume;
  });

  // Cache for 2 seconds (universe updates frequently)
  queryCache.set(cacheKey, sorted, 2000);
  return sorted;
}

export function getMarketDetail(
  tokenId: string,
  options?: {
    featureLimit?: number;
    decisionLimit?: number;
  }
) {
  const { sqlite } = getDb();
  const featureLimit = options?.featureLimit ?? 300;
  const decisionLimit = options?.decisionLimit ?? 120;
  const meta = sqlite.prepare(
    `SELECT t.id as tokenId, t.market_id as marketId, t.outcome as outcome, m.question as question, m.slug as slug
     FROM tokens t JOIN markets m ON m.id = t.market_id WHERE t.id = ?`,
  ).get(tokenId) as { tokenId: string; marketId: string; outcome: string | null; question: string | null; slug: string | null } | undefined;

  const features = sqlite.prepare(
    `SELECT ts, mid, obi, microprice_minus_mid as micropriceMinusMid, spread, accel_1m as accel1m, skew_30m as skew30m, entropy_30m as entropy30m
     FROM features WHERE token_id = ? ORDER BY ts DESC LIMIT ?`,
  ).all(tokenId, featureLimit) as {
    ts: number;
    mid: number | null;
    obi: number | null;
    micropriceMinusMid: number | null;
    spread: number | null;
    accel1m: number | null;
    skew30m: number | null;
    entropy30m: number | null;
  }[];

  const decisions = queryDecisionEdges(sqlite, {
    tokenId,
    limit: decisionLimit
  });

  return {
    meta,
    features: features.reverse(),
    decisions
  };
}

export function getDefaultTokenIdForMarket(marketId: string): string | null {
  const { sqlite } = getDb();
  const row = sqlite.prepare(
    `SELECT t.id as tokenId
     FROM tokens t
     LEFT JOIN latest_features lf ON lf.token_id = t.id
     WHERE t.market_id = ?
     ORDER BY COALESCE(lf.ts, 0) DESC, t.id ASC
     LIMIT 1`,
  ).get(marketId) as { tokenId: string } | undefined;
  return row?.tokenId ?? null;
}

export type MakerPositionRow = {
  walletId: number;
  walletName: string;
  tokenId: string;
  marketId: string | null;
  question: string | null;
  outcome: string | null;
  position: number;
  side: "LONG" | "SHORT";
  avgEntry: number;
  mid: number | null;
  realized: number;
  unrealized: number;
  ts: number;
};

export type ShadowPositionRow = {
  id: string;
  walletId: number;
  walletName: string;
  tokenId: string;
  marketId: string | null;
  question: string | null;
  outcome: string | null;
  side: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  mid: number | null;
  realized: number;
  unrealized: number;
  tsOpen: number;
  kind: "maker" | "taker";
};

export type ShadowClosedPositionRow = {
  id: string;
  walletId: number;
  walletName: string;
  tokenId: string;
  marketId: string | null;
  question: string | null;
  outcome: string | null;
  side: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  exitPrice: number;
  realized: number;
  tsOpen: number;
  tsClose: number;
  kind: "taker";
};

export function getMakerPositions(walletId: number): MakerPositionRow[] {
  const { sqlite } = getDb();
  const walletRow = sqlite
    .prepare("SELECT id as walletId, name as walletName FROM wallets WHERE id = ?")
    .get(walletId) as { walletId: number; walletName: string } | undefined;
  if (!walletRow) return [];

  const states = loadShadowMakerStates(sqlite);
  const walletStates = Array.from(states.values()).filter((s) => s.walletId === walletId);
  if (walletStates.length === 0) return [];

  const tokenIds = Array.from(new Set(walletStates.map((s) => s.tokenId)));
  const tokenMeta = new Map<
    string,
    { marketId: string | null; question: string | null; outcome: string | null }
  >();
  if (tokenIds.length > 0) {
    const placeholders = tokenIds.map(() => "?").join(",");
    const rows = sqlite
      .prepare(
        `SELECT t.id as tokenId, t.market_id as marketId, t.outcome as outcome, m.question as question
         FROM tokens t
         JOIN markets m ON m.id = t.market_id
         WHERE t.id IN (${placeholders})`
      )
      .all(...tokenIds) as Array<{
        tokenId: string;
        marketId: string | null;
        outcome: string | null;
        question: string | null;
      }>;
    for (const row of rows) {
      tokenMeta.set(row.tokenId, {
        marketId: row.marketId,
        question: row.question,
        outcome: row.outcome
      });
    }
  }

  const marks = new Map<string, number>();
  if (tokenIds.length > 0) {
    const placeholders = tokenIds.map(() => "?").join(",");
    const rows = sqlite
      .prepare(
        `SELECT token_id as tokenId, mid
         FROM latest_features
         WHERE mid IS NOT NULL AND token_id IN (${placeholders})`
      )
      .all(...tokenIds) as Array<{ tokenId: string; mid: number }>;
    for (const row of rows) {
      if (Number.isFinite(row.mid)) {
        marks.set(row.tokenId, row.mid);
      }
    }
  }

  const rows: MakerPositionRow[] = [];
  for (const state of walletStates) {
    if (state.position === 0) continue;
    const meta = tokenMeta.get(state.tokenId);
    const mid = marks.get(state.tokenId) ?? null;
    const unrealized = computeShadowUnrealized(state, mid ?? state.avgEntry);
    rows.push({
      walletId: walletRow.walletId,
      walletName: walletRow.walletName,
      tokenId: state.tokenId,
      marketId: meta?.marketId ?? null,
      question: meta?.question ?? null,
      outcome: meta?.outcome ?? null,
      position: state.position,
      side: state.position > 0 ? "LONG" : "SHORT",
      avgEntry: state.avgEntry,
      mid,
      realized: state.realized,
      unrealized,
      ts: state.lastTs
    });
  }

  rows.sort((a, b) => Math.abs(b.unrealized) - Math.abs(a.unrealized));
  return rows;
}

type ShadowTakerState = ShadowPnLState & {
  openTs: number | null;
};

export function getTakerPositions(
  walletId: number,
  limitClosed = 200
): { open: ShadowPositionRow[]; closed: ShadowClosedPositionRow[] } {
  const { sqlite } = getDb();
  const walletRow = sqlite
    .prepare("SELECT id as walletId, name as walletName FROM wallets WHERE id = ?")
    .get(walletId) as { walletId: number; walletName: string } | undefined;
  if (!walletRow) return { open: [], closed: [] };

  const fills = sqlite.prepare(
    `SELECT
       o.wallet_id as walletId,
       o.token_id as tokenId,
       o.side as side,
       f.price as price,
       f.size as size,
       f.ts as ts
     FROM shadow_fills f
     JOIN shadow_orders o ON o.id = f.order_id
     WHERE o.kind IN ('TAKER_BUY','TAKER_SELL')
       AND f.method != 'synthetic_fill'
       AND o.wallet_id = ?
     ORDER BY f.ts ASC`
  ).all(walletId) as ShadowFillRow[];

  if (!fills.length) return { open: [], closed: [] };

  const states = new Map<string, ShadowTakerState>();
  const closed: ShadowClosedPositionRow[] = [];

  for (const fill of fills) {
    if (!Number.isFinite(fill.price) || !Number.isFinite(fill.size)) continue;
    const key = `${fill.walletId}:${fill.tokenId}`;
    const state =
      states.get(key) ?? {
        walletId: fill.walletId,
        tokenId: fill.tokenId,
        position: 0,
        avgEntry: 0,
        realized: 0,
        lastTs: fill.ts,
        openTs: null
      };

    const prevPos = state.position;
    const prevAvg = state.avgEntry;
    const prevOpenTs = state.openTs;
    const delta = fill.side === "BUY" ? fill.size : -fill.size;
    const nextPos = prevPos + delta;
    const opensNow = prevPos === 0 && nextPos !== 0;
    const closesNow = prevPos !== 0 && nextPos === 0;
    const flips =
      prevPos !== 0 &&
      nextPos !== 0 &&
      Math.sign(prevPos) !== Math.sign(nextPos);
    const closesPartially =
      prevPos !== 0 && Math.sign(prevPos) !== Math.sign(delta);

    const nextCore = applyShadowFill(state, fill);
    state.position = nextCore.position;
    state.avgEntry = nextCore.avgEntry;
    state.realized = nextCore.realized;
    state.lastTs = Math.max(state.lastTs, fill.ts);

    if (opensNow) {
      state.openTs = fill.ts;
    }

    if (closesPartially) {
      const closingSize = Math.min(Math.abs(prevPos), Math.abs(delta));
      if (closingSize > 0) {
        const pnlPerUnit = prevPos > 0 ? fill.price - prevAvg : prevAvg - fill.price;
        const realizedDelta = pnlPerUnit * closingSize;
        closed.push({
          id: `${fill.walletId}:${fill.tokenId}:${fill.ts}:${closed.length}`,
          walletId: walletRow.walletId,
          walletName: walletRow.walletName,
          tokenId: fill.tokenId,
          marketId: null,
          question: null,
          outcome: null,
          side: prevPos > 0 ? "LONG" : "SHORT",
          size: closingSize,
          entryPrice: prevAvg,
          exitPrice: fill.price,
          realized: realizedDelta,
          tsOpen: prevOpenTs ?? fill.ts,
          tsClose: fill.ts,
          kind: "taker"
        });
      }
    }

    if (closesNow) {
      state.openTs = null;
    } else if (flips) {
      state.openTs = fill.ts;
    } else if (!opensNow && state.openTs == null && state.position !== 0) {
      state.openTs = fill.ts;
    }

    states.set(key, state);
  }

  const tokenIds = new Set<string>();
  for (const state of states.values()) tokenIds.add(state.tokenId);
  for (const row of closed) tokenIds.add(row.tokenId);

  const tokenMeta = new Map<
    string,
    { marketId: string | null; question: string | null; outcome: string | null }
  >();
  if (tokenIds.size > 0) {
    const ids = Array.from(tokenIds);
    const placeholders = ids.map(() => "?").join(",");
    const rows = sqlite
      .prepare(
        `SELECT t.id as tokenId, t.market_id as marketId, t.outcome as outcome, m.question as question
         FROM tokens t
         JOIN markets m ON m.id = t.market_id
         WHERE t.id IN (${placeholders})`
      )
      .all(...ids) as Array<{
        tokenId: string;
        marketId: string | null;
        outcome: string | null;
        question: string | null;
      }>;
    for (const row of rows) {
      tokenMeta.set(row.tokenId, {
        marketId: row.marketId,
        question: row.question,
        outcome: row.outcome
      });
    }
  }

  const marks = new Map<string, number>();
  if (tokenIds.size > 0) {
    const ids = Array.from(tokenIds);
    const placeholders = ids.map(() => "?").join(",");
    const rows = sqlite
      .prepare(
        `SELECT token_id as tokenId, mid
         FROM latest_features
         WHERE mid IS NOT NULL AND token_id IN (${placeholders})`
      )
      .all(...ids) as Array<{ tokenId: string; mid: number }>;
    for (const row of rows) {
      if (Number.isFinite(row.mid)) {
        marks.set(row.tokenId, row.mid);
      }
    }
  }

  const open: ShadowPositionRow[] = [];
  for (const state of states.values()) {
    if (state.position === 0) continue;
    const meta = tokenMeta.get(state.tokenId);
    const mid = marks.get(state.tokenId) ?? null;
    const unrealized = computeShadowUnrealized(state, mid ?? state.avgEntry);
    open.push({
      id: `${walletRow.walletId}:${state.tokenId}`,
      walletId: walletRow.walletId,
      walletName: walletRow.walletName,
      tokenId: state.tokenId,
      marketId: meta?.marketId ?? null,
      question: meta?.question ?? null,
      outcome: meta?.outcome ?? null,
      side: state.position > 0 ? "LONG" : "SHORT",
      size: Math.abs(state.position),
      entryPrice: state.avgEntry,
      mid,
      realized: state.realized,
      unrealized,
      tsOpen: state.openTs ?? state.lastTs,
      kind: "taker"
    });
  }

  for (const row of closed) {
    const meta = tokenMeta.get(row.tokenId);
    row.marketId = meta?.marketId ?? null;
    row.question = meta?.question ?? null;
    row.outcome = meta?.outcome ?? null;
  }

  open.sort((a, b) => Math.abs(b.unrealized) - Math.abs(a.unrealized));
  closed.sort((a, b) => b.tsClose - a.tsClose);
  return {
    open,
    closed: closed.slice(0, limitClosed)
  };
}

export function getAlerts(sinceId?: number) {
  const { sqlite } = getDb();
  const base = `
    SELECT
      a.*,
      COALESCE(m1.question, m2.question) as question,
      t.outcome as outcome
    FROM alerts a
    LEFT JOIN tokens t ON t.id = a.token_id
    LEFT JOIN markets m1 ON m1.id = a.market_id
    LEFT JOIN markets m2 ON m2.id = t.market_id
  `;
  const rows = sinceId
    ? (sqlite.prepare(`${base} WHERE a.id > ? ORDER BY a.id ASC`).all(sinceId) as any[])
    : (sqlite.prepare(`${base} ORDER BY a.id DESC LIMIT 50`).all() as any[]);

  return rows.map((row) => ({
    ...row,
    payload: safeParseJson(row.payload)
  }));
}

export function getEvidenceStats(): { count: number; signalCount: number; latestTs: number | null } {
  const { sqlite } = getDb();
  if (!tableExists(sqlite, "decision_log")) {
    return { count: 0, signalCount: 0, latestTs: null };
  }
  const total = sqlite.prepare("SELECT COUNT(*) as cnt FROM decision_log").get() as { cnt: number };
  const submitted = sqlite
    .prepare("SELECT COUNT(*) as cnt FROM decision_log WHERE decision = 'SUBMIT'")
    .get() as { cnt: number };
  const latest = sqlite.prepare("SELECT MAX(ts) as ts FROM decision_log").get() as { ts: number | null };
  return {
    count: total.cnt ?? 0,
    signalCount: submitted.cnt ?? 0,
    latestTs: latest.ts ?? null
  };
}

export function getEvidenceChain(limit = 10, filterId?: string | null): EvidenceEvent[] {
  return getDecisionChain(limit, filterId);
}

export function getDecisionChain(limit = 50, filterId?: string | null): EvidenceEvent[] {
  const { sqlite } = getDb();
  const rows = queryDecisionEdges(sqlite, {
    limit: Math.max(limit * 3, limit),
    tokenId: filterId ?? null
  });
  const events: EvidenceEvent[] = [];

  for (const row of rows) {
    if (row.decision === "SKIP") {
      const failType = mapDecisionReasonToFailType(row.decisionReason);
      events.push({
        id: `decision-${row.decisionId}`,
        type: failType,
        ts: row.ts,
        title: `${row.kind} SKIP`,
        details: `${row.decisionReason ?? "unknown"} · lane=${row.strategyLane ?? "n/a"} · token=${row.tokenId.slice(0, 8)}`,
        metadata: {
          decisionId: row.decisionId,
          tokenId: row.tokenId,
          kind: row.kind,
          reason: row.decisionReason,
          netEdgeBps: row.netEdgeBps
        }
      });
      continue;
    }

    events.push({
      id: `decision-${row.decisionId}`,
      type: "ORDER_SUBMITTED",
      ts: row.ts,
      title: `${row.kind} ${row.decision}`,
      details: `group=${row.decisionGroupId ?? "none"} · net_edge=${row.netEdgeBps?.toFixed(2) ?? "-"}bps · size=${row.size?.toFixed(2) ?? "-"} · orders=${row.ordersCount}`,
      metadata: {
        decisionId: row.decisionId,
        tokenId: row.tokenId,
        walletId: row.walletId,
        kind: row.kind,
        lane: row.strategyLane,
        decision: row.decision,
        decisionReason: row.decisionReason
      }
    });

    if (row.fillsCount > 0) {
      events.push({
        id: `fills-${row.decisionId}`,
        type: "FILLED",
        ts: row.ts,
        title: `Fills for decision ${row.decisionId}`,
        details: `fills=${row.fillsCount} · notional=${row.fillNotional.toFixed(4)}`,
        metadata: {
          decisionId: row.decisionId,
          fillsCount: row.fillsCount,
          fillNotional: row.fillNotional
        }
      });
    }

    if (row.markout1mBpsAvg != null || row.markout5mBpsAvg != null) {
      events.push({
        id: `markout-${row.decisionId}`,
        type: "MARKOUT",
        ts: row.ts,
        title: `Markout summary ${row.decisionId}`,
        details: `1m=${row.markout1mBpsAvg?.toFixed(2) ?? "-"}bps · 5m=${row.markout5mBpsAvg?.toFixed(2) ?? "-"}bps`,
        metadata: {
          decisionId: row.decisionId,
          markout1mBpsAvg: row.markout1mBpsAvg,
          markout5mBpsAvg: row.markout5mBpsAvg
        }
      });
    }
  }

  events.sort((a, b) => b.ts - a.ts);
  return events.slice(0, limit);
}

function mapDecisionReasonToFailType(reason: string | null): EvidenceEventType {
  if (!reason) return "REGIME_BLOCK";
  if (reason === "net_edge_le_0") return "EDGE_FAIL";
  if (reason === "inventory_build") return "INVENTORY_FAIL";
  if (reason.startsWith("maker_flow_gate_")) return "FLOW_GATE";
  if (reason.startsWith("toxicity_gate:")) return "FLOW_GATE";
  if (reason.startsWith("regime_block:")) return "REGIME_BLOCK";
  return "REGIME_BLOCK";
}

export type SystemRejectEvent = {
  id: string;
  type: EvidenceEventType;
  ts: number;
  title: string;
  details: string;
  metadata?: Record<string, unknown>;
};

export function getSystemRejects(limit = 50, since?: number): SystemRejectEvent[] {
  const { sqlite } = getDb();
  let rows: Array<{ id: number; ts: number; token_id: string; kind: string; decision_reason: string | null }>;
  try {
    if (since != null) {
      rows = sqlite
        .prepare(
          `SELECT id, ts, token_id, kind, decision_reason
           FROM decision_log
           WHERE decision = 'SKIP' AND ts >= ?
           ORDER BY ts DESC
           LIMIT ?`
        )
        .all(since, limit) as Array<{ id: number; ts: number; token_id: string; kind: string; decision_reason: string | null }>;
    } else {
      rows = sqlite
        .prepare(
          `SELECT id, ts, token_id, kind, decision_reason
           FROM decision_log
           WHERE decision = 'SKIP'
           ORDER BY ts DESC
           LIMIT ?`
        )
        .all(limit) as Array<{ id: number; ts: number; token_id: string; kind: string; decision_reason: string | null }>;
    }
  } catch {
    return [];
  }
  return rows.map((r) => {
    const failType = mapDecisionReasonToFailType(r.decision_reason);
    const reason = r.decision_reason ?? "unknown";
    return {
      id: `reject-${r.id}`,
      type: failType,
      ts: r.ts,
      title: `${failType.replace("_", " ")}`,
      details: `${r.kind} · ${r.token_id.slice(0, 8)} · ${reason}`,
      metadata: { tokenId: r.token_id, kind: r.kind, decision_reason: reason }
    };
  });
}

function safeParseJson(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export type TokenInfo = {
  tokenId: string;
  outcome: string | null;
  question: string | null;
  marketId: string | null;
};

export function getTokenInfo(tokenId: string): TokenInfo | null {
  const { sqlite } = getDb();
  const row = sqlite
    .prepare(
      `SELECT t.id as tokenId, t.outcome, t.market_id as marketId, m.question 
       FROM tokens t 
       LEFT JOIN markets m ON m.id = t.market_id 
       WHERE t.id = ?`
    )
    .get(tokenId) as { tokenId: string; outcome: string | null; marketId: string | null; question: string | null } | undefined;

  return row ?? null;
}

export type TokenEvidenceStats = {
  signalCount: number;
  buyCount: number;
  sellCount: number;
  evidenceCount: number;
  firstSignalTs: number | null;
  latestSignalTs: number | null;
  avgConfidence: number;
  avgDeltaHat: number;
};

export function getTokenEvidenceStats(tokenId: string): TokenEvidenceStats {
  const { sqlite } = getDb();
  if (!tableExists(sqlite, "decision_log")) {
    return {
      signalCount: 0,
      buyCount: 0,
      sellCount: 0,
      evidenceCount: 0,
      firstSignalTs: null,
      latestSignalTs: null,
      avgConfidence: 0,
      avgDeltaHat: 0
    };
  }
  const decisionStats = sqlite
    .prepare(
      `SELECT
         COUNT(*) as totalDecisions,
         SUM(CASE WHEN decision = 'SUBMIT' THEN 1 ELSE 0 END) as submitCount,
         SUM(CASE WHEN decision = 'SUBMIT' AND kind IN ('TAKER_BUY', 'MAKER_BID') THEN 1 ELSE 0 END) as buyCount,
         SUM(CASE WHEN decision = 'SUBMIT' AND kind IN ('TAKER_SELL', 'MAKER_ASK') THEN 1 ELSE 0 END) as sellCount,
         MIN(CASE WHEN decision = 'SUBMIT' THEN ts END) as firstSubmitTs,
         MAX(CASE WHEN decision = 'SUBMIT' THEN ts END) as latestSubmitTs,
         AVG(CASE WHEN decision = 'SUBMIT' THEN CASE WHEN COALESCE(net_edge_bps, 0) > 0 THEN 1.0 ELSE 0.0 END END) as avgConfidence,
         AVG(CASE WHEN decision = 'SUBMIT' THEN ABS(COALESCE(delta_hat, pred_edge_bps / 10000.0, 0)) END) as avgDeltaHat
       FROM decision_log
       WHERE token_id = ?`
    )
    .get(tokenId) as {
      totalDecisions: number;
      submitCount: number;
      buyCount: number;
      sellCount: number;
      firstSubmitTs: number | null;
      latestSubmitTs: number | null;
      avgConfidence: number | null;
      avgDeltaHat: number | null;
    };

  return {
    signalCount: decisionStats?.submitCount ?? 0,
    buyCount: decisionStats?.buyCount ?? 0,
    sellCount: decisionStats?.sellCount ?? 0,
    evidenceCount: decisionStats?.totalDecisions ?? 0,
    firstSignalTs: decisionStats?.firstSubmitTs ?? null,
    latestSignalTs: decisionStats?.latestSubmitTs ?? null,
    avgConfidence: decisionStats?.avgConfidence ?? 0,
    avgDeltaHat: decisionStats?.avgDeltaHat ?? 0,
  };
}
