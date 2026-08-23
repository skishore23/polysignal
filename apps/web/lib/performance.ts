import { getDb } from "./db";
import {
  buildShadowPositionLedger,
  markShadowPosition,
  type ShadowFillInput
} from "@polysignal/data";

export type TakerSystemMetrics = {
  fillCount: number;
  totalPositions: number;
  openPositions: number;
  openedCycles: number;
  closedPositions: number;
  closeRatio: number;
  realizedPnl: number;
  unrealizedPnl: number;
  netPnl: number;
  longExposure: number;
  shortExposure: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgHoldSec: number;
};

export type MakerSystemMetrics = {
  openPositions: number;
  totalRealized: number;
  totalUnrealized: number;
  netPnl: number;
  avgSpreadCapture: number;
  avgFillRate: number;
  avgQMin: number;
  rewardEligibleRate24h: number;
  rewardEligibleCount24h: number;
  rewardTotalCount24h: number;
  rewardAvgQMin24h: number;
  makerVolume24h: number;
  feeEquivalent24h: number;
  rebateUpperBound24h: number;
  rebatePoolPct: number;
  fillCount: number;
  longExposure: number;
  shortExposure: number;
};

type CachedMakerMetricsRow = {
  updated_ts: number;
  window_hours: number;
  open_positions: number;
  total_realized: number;
  total_unrealized: number;
  fill_count: number;
  long_exposure: number;
  short_exposure: number;
  maker_volume_24h: number;
  fee_equivalent_24h: number;
  rebate_upper_bound_24h: number;
  rebate_pool_pct: number;
};

type ShadowFillRow = ShadowFillInput;
type TakerFillRow = ShadowFillInput;

type RewardOrderRow = {
  ts: number;
  walletId: number | null;
  marketId: string | null;
  tokenId: string;
  side: "BUY" | "SELL" | null;
  price: number | null;
  size: number | null;
  midPx: number | null;
  rewardMinSize: number | null;
  rewardMaxSpread: number | null;
  rewardRatesJson: string | null;
};

type RewardStats = {
  totalCount: number;
  eligibleCount: number;
  eligibleRate: number;
  avgQMin: number;
  avgQMinEligible: number;
};

const SINGLE_SIDED_MID_MIN = 0.1;
const SINGLE_SIDED_MID_MAX = 0.9;
const SINGLE_SIDED_SCALE = 3.0;
const MIN_NON_ZERO_FEE_USDC = 0.0001;
const FEE_ROUND_DECIMALS = 4;
const CRYPTO_15M_FEE_RATE = 0.25;
const CRYPTO_15M_FEE_EXPONENT = 2;
const CRYPTO_5M_FEE_RATE = 0.25;
const CRYPTO_5M_FEE_EXPONENT = 2;
const SPORTS_FEE_RATE = 0.0175;
const SPORTS_FEE_EXPONENT = 1;
const CRYPTO_15M_REBATE_POOL_PCT = 0.2;
const CRYPTO_5M_REBATE_POOL_PCT = 0;
const SPORTS_REBATE_POOL_PCT = 0.25;
const MAX_SHADOW_FILLS_FOR_METRICS = 20_000;
const DECISION_LOG_RECENT_LIMIT = 100_000;
const RUNTIME_SKIP_ROW_LIMIT = 100_000;

type WalletLaneCapabilities = {
  makerEnabled: boolean;
  takerEnabled: boolean;
};

const resolveWalletLaneCapabilities = (
  sqlite: ReturnType<typeof getDb>["sqlite"],
  walletId: number | null
): WalletLaneCapabilities => {
  if (walletId == null) return { makerEnabled: true, takerEnabled: true };
  try {
    const row = sqlite
      .prepare(
        `SELECT
           COALESCE(maker_enabled, 0) as makerEnabled,
           COALESCE(auto_trade_enabled, 0) as autoTradeEnabled,
           COALESCE(taker_side, 'NONE') as takerSide
         FROM wallets
         WHERE id = ?`
      )
      .get(walletId) as
      | {
          makerEnabled: number | null;
          autoTradeEnabled: number | null;
          takerSide: string | null;
        }
      | undefined;
    if (!row) return { makerEnabled: true, takerEnabled: true };
    const takerSide = String(row.takerSide ?? "NONE").toUpperCase();
    return {
      makerEnabled: Boolean(row.makerEnabled),
      takerEnabled: Boolean(row.autoTradeEnabled) && takerSide !== "NONE"
    };
  } catch {
    return { makerEnabled: true, takerEnabled: true };
  }
};

const parseRewardMultiplier = (raw: string | null): number => {
  if (!raw) return 1;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const val =
      parsed.in_game_multiplier ??
      parsed.inGameMultiplier ??
      parsed.in_play_multiplier ??
      parsed.inPlayMultiplier ??
      parsed.pre_game_multiplier ??
      parsed.preGameMultiplier ??
      parsed.pre_play_multiplier ??
      parsed.prePlayMultiplier ??
      parsed.multiplier ??
      parsed.b ??
      null;
    const num = typeof val === "string" ? Number(val) : typeof val === "number" ? val : null;
    return num != null && Number.isFinite(num) ? num : 1;
  } catch {
    return 1;
  }
};

const normalizeRewardsMaxSpreadCents = (value: number | null): number | null => {
  if (!Number.isFinite(value) || value == null || value <= 0) return null;
  return value;
};

const computeRewardScore = (row: RewardOrderRow): number => {
  const mid = row.midPx;
  const price = row.price;
  const size = row.size;
  const maxSpreadCents = normalizeRewardsMaxSpreadCents(row.rewardMaxSpread);
  const minSize = row.rewardMinSize ?? 0;
  const multiplier = parseRewardMultiplier(row.rewardRatesJson);

  if (
    !Number.isFinite(mid) ||
    !Number.isFinite(price) ||
    !Number.isFinite(size) ||
    maxSpreadCents == null
  ) {
    return 0;
  }

  if ((size as number) < minSize) return 0;

  const distanceCents = Math.abs((price as number) - (mid as number)) * 100;
  if (!Number.isFinite(distanceCents) || distanceCents >= maxSpreadCents) return 0;

  const base = maxSpreadCents * (maxSpreadCents - distanceCents);
  return base * base * (size as number) * multiplier;
};

const classifyMarketProfile = (input: {
  question: string | null;
  slug: string | null;
  eventTitle: string | null;
  feeRateBps: number | null;
  takerBaseFee: number | null;
}): "CRYPTO_15M" | "CRYPTO_5M" | "SPORTS" | "UNKNOWN" | "FEE_FREE" => {
  const feeEnabled = (input.feeRateBps ?? 0) > 0 || (input.takerBaseFee ?? 0) > 0;
  if (!feeEnabled) return "FEE_FREE";
  const haystack = [input.question ?? "", input.slug ?? "", input.eventTitle ?? ""].join(" ").toLowerCase();
  const isCrypto = /\b(crypto|bitcoin|btc|ethereum|eth|solana|sol|doge|xrp|ada|bnb)\b/.test(haystack);
  const is5m = /\b(?:5\s*(?:minute|min|m)|five[\s-]*minute)\b/.test(haystack);
  const is15m = /\b(?:15\s*(?:minute|min|m)|quarter[\s-]*hour)\b/.test(haystack) && !is5m;
  if (isCrypto && is15m) return "CRYPTO_15M";
  if (isCrypto && is5m) return "CRYPTO_5M";
  if (/\b(ncaab|serie\s*a)\b/.test(haystack)) return "SPORTS";
  return "UNKNOWN";
};

const roundFeeUsdc = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const factor = 10 ** FEE_ROUND_DECIMALS;
  const rounded = Math.round(value * factor) / factor;
  if (rounded === 0) return 0;
  return Math.max(MIN_NON_ZERO_FEE_USDC, rounded);
};

const computeFeeEquivalentUsdc = (input: {
  marketProfile: "CRYPTO_15M" | "CRYPTO_5M" | "SPORTS" | "UNKNOWN" | "FEE_FREE";
  shares: number;
  price: number;
  feeRateBps: number | null;
}): number => {
  const shares = Number.isFinite(input.shares) ? Math.max(0, input.shares) : 0;
  const price = Number.isFinite(input.price) ? Math.max(0, input.price) : 0;
  if (shares <= 0 || price <= 0) return 0;

  const fallback = input.marketProfile === "CRYPTO_15M"
    ? { feeRate: CRYPTO_15M_FEE_RATE, exponent: CRYPTO_15M_FEE_EXPONENT }
    : input.marketProfile === "CRYPTO_5M"
      ? { feeRate: CRYPTO_5M_FEE_RATE, exponent: CRYPTO_5M_FEE_EXPONENT }
    : input.marketProfile === "SPORTS"
      ? { feeRate: SPORTS_FEE_RATE, exponent: SPORTS_FEE_EXPONENT }
      : null;
  if (!fallback) return 0;

  const feeRate = Number.isFinite(input.feeRateBps) && (input.feeRateBps as number) > 0
    ? (input.feeRateBps as number) / 10_000
    : fallback.feeRate;
  const raw = shares * price * feeRate * Math.pow(price * (1 - price), fallback.exponent);
  return roundFeeUsdc(raw);
};

const getMakerRebatePoolPct = (profile: "CRYPTO_15M" | "CRYPTO_5M" | "SPORTS" | "UNKNOWN" | "FEE_FREE"): number => {
  if (profile === "CRYPTO_15M") return CRYPTO_15M_REBATE_POOL_PCT;
  if (profile === "CRYPTO_5M") return CRYPTO_5M_REBATE_POOL_PCT;
  if (profile === "SPORTS") return SPORTS_REBATE_POOL_PCT;
  return 0;
};

const computeRewardStats24h = (
  sqlite: ReturnType<typeof getDb>["sqlite"],
  walletId: number | null,
  sinceTs: number
): RewardStats => {
  try {
    const rows = sqlite
      .prepare(
        `SELECT
           o.ts as ts,
           o.wallet_id as walletId,
           o.market_id as marketId,
           o.token_id as tokenId,
           o.side as side,
           o.price as price,
           o.size as size,
           COALESCE(o.mid_px, lf.mid) as midPx,
           m.rewards_min_size as rewardMinSize,
           m.rewards_max_spread as rewardMaxSpread,
           m.rewards_rates_json as rewardRatesJson
         FROM shadow_orders o
         LEFT JOIN markets m ON m.id = o.market_id
         LEFT JOIN latest_features lf ON lf.token_id = o.token_id
         WHERE o.kind IN ('MAKER_BID','MAKER_ASK')
           AND o.ts >= @since
           ${walletId != null ? "AND o.wallet_id = @walletId" : ""}`
      )
      .all(walletId != null ? { since: sinceTs, walletId } : { since: sinceTs }) as RewardOrderRow[];

    if (!rows.length) {
      return {
        totalCount: 0,
        eligibleCount: 0,
        eligibleRate: 0,
        avgQMin: 0,
        avgQMinEligible: 0
      };
    }

    const grouped = new Map<string, { mid: number | null; bidScore: number; askScore: number }>();

    for (const row of rows) {
      const key = `${row.walletId ?? -1}:${row.marketId ?? row.tokenId}:${row.ts}`;
      const g = grouped.get(key) ?? { mid: null, bidScore: 0, askScore: 0 };
      const score = computeRewardScore(row);
      if (row.side === "BUY") g.bidScore = Math.max(g.bidScore, score);
      if (row.side === "SELL") g.askScore = Math.max(g.askScore, score);
      if (Number.isFinite(row.midPx)) g.mid = row.midPx as number;
      grouped.set(key, g);
    }

    let totalCount = 0;
    let eligibleCount = 0;
    let qMinSum = 0;
    let qMinEligibleSum = 0;

    for (const sample of grouped.values()) {
      const qOne = sample.bidScore;
      const qTwo = sample.askScore;
      let qMin = Math.min(qOne, qTwo);

      if (
        sample.mid != null &&
        Number.isFinite(sample.mid) &&
        sample.mid >= SINGLE_SIDED_MID_MIN &&
        sample.mid <= SINGLE_SIDED_MID_MAX
      ) {
        const singleSided = Math.max(qOne / SINGLE_SIDED_SCALE, qTwo / SINGLE_SIDED_SCALE);
        qMin = Math.max(qMin, singleSided);
      }

      totalCount += 1;
      qMinSum += qMin;
      if (qMin > 0) {
        eligibleCount += 1;
        qMinEligibleSum += qMin;
      }
    }

    return {
      totalCount,
      eligibleCount,
      eligibleRate: totalCount > 0 ? eligibleCount / totalCount : 0,
      avgQMin: totalCount > 0 ? qMinSum / totalCount : 0,
      avgQMinEligible: eligibleCount > 0 ? qMinEligibleSum / eligibleCount : 0
    };
  } catch {
    return {
      totalCount: 0,
      eligibleCount: 0,
      eligibleRate: 0,
      avgQMin: 0,
      avgQMinEligible: 0
    };
  }
};

const computeShadowMakerMetrics = (
  sqlite: ReturnType<typeof getDb>["sqlite"],
  walletId: number | null
) => {
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const walletClause = walletId != null ? "AND o.wallet_id = @walletId" : "";
  const params =
    walletId != null
      ? { walletId, since: since24h, limit: MAX_SHADOW_FILLS_FOR_METRICS }
      : { since: since24h, limit: MAX_SHADOW_FILLS_FOR_METRICS };

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
       AND f.ts >= @since
       ${walletClause}
     ORDER BY f.ts DESC, f.id DESC
     LIMIT @limit`
  ).all(params) as ShadowFillRow[];
  fills.reverse();

  const fillCount = fills.length;
  if (fillCount === 0) {
    return {
      openPositions: 0,
      totalRealized: 0,
      totalUnrealized: 0,
      netPnl: 0,
      longExposure: 0,
      shortExposure: 0,
      fillCount
    };
  }

  const tokens = Array.from(new Set(fills.map((fill) => fill.tokenId)));
  const marks = new Map<string, number>();
  if (tokens.length > 0) {
    const placeholders = tokens.map(() => "?").join(",");
    const rows = sqlite
      .prepare(
        `SELECT token_id as tokenId, mid
         FROM latest_features
         WHERE mid IS NOT NULL AND token_id IN (${placeholders})`
      )
      .all(...tokens) as Array<{ tokenId: string; mid: number }>;
    for (const row of rows) {
      if (Number.isFinite(row.mid)) {
        marks.set(row.tokenId, row.mid);
      }
    }
  }

  const states = buildShadowPositionLedger(fills);

  let totalRealized = 0;
  let totalUnrealized = 0;
  let longExposure = 0;
  let shortExposure = 0;
  let openPositions = 0;

  for (const state of states.values()) {
    totalRealized += state.realizedPnl;
    if (state.position !== 0) {
      openPositions += 1;
    }

    const mark = marks.get(state.tokenId) ?? state.avgEntry;
    if (!Number.isFinite(mark) || mark <= 0) continue;
    const marked = markShadowPosition(state, mark);
    longExposure += marked.longExposure;
    shortExposure += marked.shortExposure;
    totalUnrealized += marked.unrealizedPnl;
  }

  return {
    openPositions,
    totalRealized,
    totalUnrealized,
    netPnl: totalRealized + totalUnrealized,
    longExposure,
    shortExposure,
    fillCount
  };
};

const computeTakerMetrics = (
  sqlite: ReturnType<typeof getDb>["sqlite"],
  walletId: number | null,
  capabilities: WalletLaneCapabilities
): TakerSystemMetrics => {
  if (walletId != null && !capabilities.takerEnabled) {
    return {
      fillCount: 0,
      totalPositions: 0,
      openPositions: 0,
      openedCycles: 0,
      closedPositions: 0,
      closeRatio: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      netPnl: 0,
      longExposure: 0,
      shortExposure: 0,
      winCount: 0,
      lossCount: 0,
      winRate: 0,
      avgHoldSec: 0
    };
  }
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const walletClause = walletId != null ? "AND o.wallet_id = @walletId" : "";
  const params =
    walletId != null
      ? { walletId, since: since24h, limit: MAX_SHADOW_FILLS_FOR_METRICS }
      : { since: since24h, limit: MAX_SHADOW_FILLS_FOR_METRICS };

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
       AND f.ts >= @since
       ${walletClause}
     ORDER BY f.ts DESC, f.id DESC
     LIMIT @limit`
  ).all(params) as TakerFillRow[];
  fills.reverse();

  if (!fills.length) {
    return {
      fillCount: 0,
      totalPositions: 0,
      openPositions: 0,
      openedCycles: 0,
      closedPositions: 0,
      closeRatio: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      netPnl: 0,
      longExposure: 0,
      shortExposure: 0,
      winCount: 0,
      lossCount: 0,
      winRate: 0,
      avgHoldSec: 0
    };
  }

  const states = buildShadowPositionLedger(fills);
  const tokens = Array.from(new Set(fills.map((fill) => fill.tokenId)));
  const marks = new Map<string, number>();
  if (tokens.length > 0) {
    const placeholders = tokens.map(() => "?").join(",");
    const rows = sqlite
      .prepare(
        `SELECT token_id as tokenId, mid
         FROM latest_features
         WHERE mid IS NOT NULL AND token_id IN (${placeholders})`
      )
      .all(...tokens) as Array<{ tokenId: string; mid: number }>;
    for (const row of rows) {
      if (Number.isFinite(row.mid)) marks.set(row.tokenId, row.mid);
    }
  }

  let openPositions = 0;
  let openedCycles = 0;
  let closedPositions = 0;
  let realizedPnl = 0;
  let unrealizedPnl = 0;
  let longExposure = 0;
  let shortExposure = 0;
  let winCount = 0;
  let lossCount = 0;
  let totalHoldSec = 0;

  for (const state of states.values()) {
    realizedPnl += state.realizedPnl;
    if (state.position !== 0) openPositions += 1;
    openedCycles += state.openedCycles;
    closedPositions += state.closedCycles;
    winCount += state.winCount;
    lossCount += state.lossCount;
    totalHoldSec += state.totalHoldSec;
    const mark = marks.get(state.tokenId) ?? state.avgEntry;
    if (Number.isFinite(mark) && mark > 0) {
      const marked = markShadowPosition(state, mark);
      unrealizedPnl += marked.unrealizedPnl;
      longExposure += marked.longExposure;
      shortExposure += marked.shortExposure;
    }
  }

  const totalPositions = openPositions + closedPositions;
  const closeRatio = openedCycles > 0 ? closedPositions / openedCycles : 0;
  const winRate = closedPositions > 0 ? winCount / closedPositions : 0;
  const avgHoldSec = closedPositions > 0 ? totalHoldSec / closedPositions : 0;

  return {
    fillCount: fills.length,
    totalPositions,
    openPositions,
    openedCycles,
    closedPositions,
    closeRatio,
    realizedPnl,
    unrealizedPnl,
    netPnl: realizedPnl + unrealizedPnl,
    longExposure,
    shortExposure,
    winCount,
    lossCount,
    winRate,
    avgHoldSec
  };
};

/** % of maker decisions where |q − target| > band (inventory outside band). */
export type TimeOutsideBandMetric = {
  /** Numerator: maker orders in window where |inventory_i_before| > band/qMax. */
  outsideBandCount: number;
  /** Denominator: maker orders in window with non-null inventory_i_before. */
  totalCount: number;
  /** outsideBandCount / totalCount when totalCount > 0, else 0. */
  pct: number;
};

/** Count of SKIPs by decision_reason (inventory_build, net_edge_le_0, etc.). */
export type SkipBreakdown = {
  inventory_build: number;
  net_edge_le_0: number;
  [reason: string]: number;
};

export type LaneRuntimeStatus = "running" | "idle" | "stalled" | "no_data";

export type LaneRuntimeHealth = {
  status: LaneRuntimeStatus;
  reason: string;
  heartbeatTs: number | null;
  lastOrderTs: number | null;
  lastOrderTouchTs: number | null;
  lastRealFillTs: number | null;
  lastSkipTs: number | null;
  sinceHeartbeatSec: number | null;
  sinceOrderSec: number | null;
  sinceRealFillSec: number | null;
  orders5m: number;
  realFills5m: number;
  skips5m: number;
  orders30m: number;
  realFills30m: number;
  skips30m: number;
};

export type RuntimeHealth = {
  nowTs: number;
  status: "running" | "degraded" | "stalled" | "no_data";
  reason: string;
  latestFeatureTs: number | null;
  feedFreshnessSec: number | null;
  signals5m: number;
  shadowSummaryUpdatedTs: number | null;
  shadowSummaryAgeSec: number | null;
  maker: LaneRuntimeHealth;
  taker: LaneRuntimeHealth;
};

export type ConsolidatedMetrics = {
  totalRealized: number;
  totalUnrealized: number;
  netPnl: number;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  longExposure: number;
  shortExposure: number;
  inventorySkew: number;
  avgHoldSec: number;
  avgFillRate: number;
  avgSpreadCapture: number;
  taker: TakerSystemMetrics;
  maker: MakerSystemMetrics;
  timeOutsideBand: TimeOutsideBandMetric;
  skipBreakdown: SkipBreakdown;
  runtimeHealth: RuntimeHealth;
  alpha: {
    edgeCost: Array<{
      lane: string;
      orders: number;
      avgPredEdgeBps: number;
      avgCostBps: number;
      avgNetEdgeBps: number;
      avgFeesBps: number;
      avgSlippageBps: number;
      avgAdverseBps: number;
      avgQueueBps: number;
    }>;
    arb: {
      opportunities24h: number;
      executions24h: number;
      successRate24h: number;
      avgNetEdgeBps: number;
      realizedPnl24h: number;
    };
  };
  ts: number;
};

const computeAlphaPayload = (
  sqlite: ReturnType<typeof getDb>["sqlite"],
  walletId: number | null
): ConsolidatedMetrics["alpha"] => {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const walletClause = walletId != null ? "AND wallet_id = @walletId" : "";
  const params = walletId != null ? { since, walletId } : { since };

  const edgeCost = (() => {
    try {
      return sqlite.prepare(
        `SELECT
           COALESCE(strategy_lane,
             CASE
               WHEN kind IN ('MAKER_BID', 'MAKER_ASK') THEN 'MAKER'
               WHEN kind IN ('TAKER_BUY', 'TAKER_SELL') THEN 'TAKER'
               ELSE 'UNKNOWN'
             END
           ) as lane,
           COUNT(*) as orders,
           AVG(COALESCE(pred_edge_bps, 0)) as avgPredEdgeBps,
           AVG(COALESCE(cost_bps, 0)) as avgCostBps,
           AVG(COALESCE(net_edge_bps, 0)) as avgNetEdgeBps,
           AVG(COALESCE(fees_bps, 0)) as avgFeesBps,
           AVG(COALESCE(expected_slippage_bps, 0)) as avgSlippageBps,
           AVG(COALESCE(expected_adverse_bps, 0)) as avgAdverseBps,
           AVG(COALESCE(expected_queue_bps, 0)) as avgQueueBps
         FROM shadow_orders
         WHERE ts >= @since
           ${walletClause}
         GROUP BY lane`
      ).all(params) as Array<{
        lane: string | null;
        orders: number;
        avgPredEdgeBps: number | null;
        avgCostBps: number | null;
        avgNetEdgeBps: number | null;
        avgFeesBps: number | null;
        avgSlippageBps: number | null;
        avgAdverseBps: number | null;
        avgQueueBps: number | null;
      }>;
    } catch {
      return [] as Array<{
        lane: string | null;
        orders: number;
        avgPredEdgeBps: number | null;
        avgCostBps: number | null;
        avgNetEdgeBps: number | null;
        avgFeesBps: number | null;
        avgSlippageBps: number | null;
        avgAdverseBps: number | null;
        avgQueueBps: number | null;
      }>;
    }
  })().map((row) => ({
    lane: row.lane ?? "UNKNOWN",
    orders: Number(row.orders ?? 0) || 0,
    avgPredEdgeBps: Number(row.avgPredEdgeBps ?? 0) || 0,
    avgCostBps: Number(row.avgCostBps ?? 0) || 0,
    avgNetEdgeBps: Number(row.avgNetEdgeBps ?? 0) || 0,
    avgFeesBps: Number(row.avgFeesBps ?? 0) || 0,
    avgSlippageBps: Number(row.avgSlippageBps ?? 0) || 0,
    avgAdverseBps: Number(row.avgAdverseBps ?? 0) || 0,
    avgQueueBps: Number(row.avgQueueBps ?? 0) || 0
  }));

  const arb = (() => {
    try {
      const opp = sqlite
        .prepare(`SELECT COUNT(*) as c, AVG(net_edge_bps) as avgNet FROM arb_opportunities WHERE ts >= ?`)
        .get(since) as { c: number; avgNet: number | null } | undefined;
      const exec = sqlite
        .prepare(
          `SELECT
             COUNT(*) as c,
             SUM(CASE WHEN status IN ('SUBMITTED', 'PARTIAL', 'FILLED') THEN 1 ELSE 0 END) as successC,
             SUM(COALESCE(realized_pnl, 0)) as pnl
           FROM arb_executions
           WHERE ts >= ?`
        )
        .get(since) as { c: number; successC: number | null; pnl: number | null } | undefined;

      const oppCount = Number(opp?.c ?? 0) || 0;
      const execCount = Number(exec?.c ?? 0) || 0;
      const success = Number(exec?.successC ?? 0) || 0;

      return {
        opportunities24h: oppCount,
        executions24h: execCount,
        successRate24h: execCount > 0 ? success / execCount : 0,
        avgNetEdgeBps: Number(opp?.avgNet ?? 0) || 0,
        realizedPnl24h: Number(exec?.pnl ?? 0) || 0
      };
    } catch {
      return {
        opportunities24h: 0,
        executions24h: 0,
        successRate24h: 0,
        avgNetEdgeBps: 0,
        realizedPnl24h: 0
      };
    }
  })();

  return { edgeCost, arb };
};

const computeMakerMetrics = (
  sqlite: ReturnType<typeof getDb>["sqlite"],
  walletId: number | null,
  capabilities: WalletLaneCapabilities
): MakerSystemMetrics => {
  if (walletId != null && !capabilities.makerEnabled) {
    return {
      openPositions: 0,
      totalRealized: 0,
      totalUnrealized: 0,
      netPnl: 0,
      avgSpreadCapture: 0,
      avgFillRate: 0,
      avgQMin: 0,
      rewardEligibleRate24h: 0,
      rewardEligibleCount24h: 0,
      rewardTotalCount24h: 0,
      rewardAvgQMin24h: 0,
      makerVolume24h: 0,
      feeEquivalent24h: 0,
      rebateUpperBound24h: 0,
      rebatePoolPct: 0,
      fillCount: 0,
      longExposure: 0,
      shortExposure: 0
    };
  }
  const CACHE_MAX_AGE_MS = 30_000;
  const windowHours = 24;
  const now = Date.now();
  const since24h = now - windowHours * 60 * 60 * 1000;

  const getCachedMakerMetrics = (): CachedMakerMetricsRow | null => {
    try {
      const row = sqlite
        .prepare(
          `SELECT
             updated_ts, window_hours,
             open_positions, total_realized, total_unrealized, fill_count,
             long_exposure, short_exposure,
             maker_volume_24h, fee_equivalent_24h, rebate_upper_bound_24h, rebate_pool_pct
           FROM shadow_maker_metrics_latest
           WHERE wallet_id = ?`
        )
        .get(walletId ?? 0) as CachedMakerMetricsRow | undefined;
      if (!row) return null;
      if (row.window_hours !== windowHours) return null;
      if (row.updated_ts <= Date.now() - CACHE_MAX_AGE_MS) return null;
      return row;
    } catch {
      return null;
    }
  };

  const getShadowFillRate = (): number | null => {
    if (walletId == null) {
      try {
        const cached = sqlite
          .prepare(
            `SELECT updated_ts, window_hours, maker_orders, maker_real_fills
             FROM shadow_summary_latest
             WHERE id = 1`
          )
          .get() as
          | {
              updated_ts: number;
              window_hours: number;
              maker_orders: number;
              maker_real_fills: number;
            }
          | undefined;
        if (
          cached &&
          cached.window_hours === windowHours &&
          cached.updated_ts > Date.now() - CACHE_MAX_AGE_MS
        ) {
          return cached.maker_orders > 0 ? cached.maker_real_fills / cached.maker_orders : 0;
        }
      } catch {
        // ignore cache lookup errors (e.g., table missing)
      }
    }

    try {
      const since = since24h;
      const idClause = walletId != null ? "AND wallet_id = @walletId" : "";
      const params = walletId != null ? { since, walletId } : { since };
      const makerOrders = (sqlite.prepare(
        `SELECT COUNT(*) as c FROM shadow_orders
         WHERE ts >= @since AND kind IN ('MAKER_BID','MAKER_ASK') ${idClause}`
      ).get(params) as { c: number }).c;
      const makerFills = (sqlite.prepare(
        `SELECT COUNT(*) as c
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE f.ts >= @since
           AND f.method != 'synthetic_fill'
           AND o.kind IN ('MAKER_BID','MAKER_ASK') ${
           walletId != null ? "AND o.wallet_id = @walletId" : ""
         }`
      ).get(params) as { c: number }).c;
      return makerOrders > 0 ? makerFills / makerOrders : 0;
    } catch {
      return null;
    }
  };

  const rewardStats = computeRewardStats24h(sqlite, walletId, since24h);
  const rewardTotalCount24h = rewardStats.totalCount;
  const rewardEligibleCount24h = rewardStats.eligibleCount;
  const rewardEligibleRate24h = rewardStats.eligibleRate;
  const rewardAvgQMin24h = rewardStats.avgQMinEligible;

  const getShadowSpreadCapture = (): number => {
    try {
      const params = walletId != null ? { since: since24h, walletId } : { since: since24h };
      const row = sqlite
        .prepare(
          `SELECT
             SUM(
               CASE
                 WHEN f.price IS NOT NULL
                   AND f.size IS NOT NULL
                   AND f.price > 0
                   AND f.size > 0
                   AND o.side IN ('BUY', 'SELL')
                   AND COALESCE(
                     o.mid_px,
                     CASE
                       WHEN o.bid_px IS NOT NULL AND o.ask_px IS NOT NULL THEN (o.bid_px + o.ask_px) / 2.0
                       ELSE NULL
                     END
                   ) > 0
                 THEN
                   (
                     CASE
                       WHEN o.side = 'BUY' THEN
                         (
                           COALESCE(
                             o.mid_px,
                             CASE
                               WHEN o.bid_px IS NOT NULL AND o.ask_px IS NOT NULL THEN (o.bid_px + o.ask_px) / 2.0
                               ELSE NULL
                             END
                           ) - f.price
                         ) / COALESCE(
                           o.mid_px,
                           CASE
                             WHEN o.bid_px IS NOT NULL AND o.ask_px IS NOT NULL THEN (o.bid_px + o.ask_px) / 2.0
                             ELSE NULL
                           END
                         ) * 10000.0
                       ELSE
                         (
                           f.price - COALESCE(
                             o.mid_px,
                             CASE
                               WHEN o.bid_px IS NOT NULL AND o.ask_px IS NOT NULL THEN (o.bid_px + o.ask_px) / 2.0
                               ELSE NULL
                             END
                           )
                         ) / COALESCE(
                           o.mid_px,
                           CASE
                             WHEN o.bid_px IS NOT NULL AND o.ask_px IS NOT NULL THEN (o.bid_px + o.ask_px) / 2.0
                             ELSE NULL
                           END
                         ) * 10000.0
                     END
                   ) * (f.price * f.size)
                 ELSE 0
               END
             ) as weighted_capture_bps_numer,
             SUM(
               CASE
                 WHEN f.price IS NOT NULL
                  AND f.size IS NOT NULL
                  AND f.price > 0
                  AND f.size > 0
                   AND o.side IN ('BUY', 'SELL')
                   AND COALESCE(
                     o.mid_px,
                     CASE
                       WHEN o.bid_px IS NOT NULL AND o.ask_px IS NOT NULL THEN (o.bid_px + o.ask_px) / 2.0
                       ELSE NULL
                     END
                   ) > 0
                 THEN (f.price * f.size)
                 ELSE 0
               END
             ) as weighted_notional,
             AVG(
               CASE
                 WHEN f.price IS NOT NULL
                   AND f.size IS NOT NULL
                   AND f.price > 0
                   AND f.size > 0
                   AND o.side IN ('BUY', 'SELL')
                   AND COALESCE(
                     o.mid_px,
                     CASE
                       WHEN o.bid_px IS NOT NULL AND o.ask_px IS NOT NULL THEN (o.bid_px + o.ask_px) / 2.0
                       ELSE NULL
                     END
                   ) > 0
                 THEN
                   CASE
                     WHEN o.side = 'BUY' THEN
                       (
                         COALESCE(
                           o.mid_px,
                           CASE
                             WHEN o.bid_px IS NOT NULL AND o.ask_px IS NOT NULL THEN (o.bid_px + o.ask_px) / 2.0
                             ELSE NULL
                           END
                         ) - f.price
                       ) / COALESCE(
                         o.mid_px,
                         CASE
                           WHEN o.bid_px IS NOT NULL AND o.ask_px IS NOT NULL THEN (o.bid_px + o.ask_px) / 2.0
                           ELSE NULL
                         END
                       ) * 10000.0
                     ELSE
                       (
                         f.price - COALESCE(
                           o.mid_px,
                           CASE
                             WHEN o.bid_px IS NOT NULL AND o.ask_px IS NOT NULL THEN (o.bid_px + o.ask_px) / 2.0
                             ELSE NULL
                           END
                         )
                       ) / COALESCE(
                         o.mid_px,
                         CASE
                           WHEN o.bid_px IS NOT NULL AND o.ask_px IS NOT NULL THEN (o.bid_px + o.ask_px) / 2.0
                           ELSE NULL
                         END
                       ) * 10000.0
                   END
                 ELSE NULL
               END
             ) as avg_capture_bps
           FROM shadow_fills f
           JOIN shadow_orders o ON o.id = f.order_id
           WHERE f.ts >= @since
             AND f.method != 'synthetic_fill'
             AND o.kind IN ('MAKER_BID','MAKER_ASK')
             ${walletId != null ? "AND o.wallet_id = @walletId" : ""}`
        )
        .get(params) as
        | {
            weighted_capture_bps_numer: number | null;
            weighted_notional: number | null;
            avg_capture_bps: number | null;
          }
        | undefined;

      const weightedNotional = row?.weighted_notional ?? null;
      if (weightedNotional != null && Number.isFinite(weightedNotional) && weightedNotional > 0) {
        const weightedCaptureBpsNumer = row?.weighted_capture_bps_numer ?? 0;
        if (Number.isFinite(weightedCaptureBpsNumer)) {
          const avgCaptureBps = weightedCaptureBpsNumer / weightedNotional;
          return avgCaptureBps / 10_000;
        }
      }

      const avgCaptureBps = row?.avg_capture_bps ?? null;
      if (avgCaptureBps != null && Number.isFinite(avgCaptureBps)) {
        return avgCaptureBps / 10_000;
      }
      return 0;
    } catch {
      return 0;
    }
  };

  const cachedMetrics = getCachedMakerMetrics();

  let makerVolume24h = cachedMetrics?.maker_volume_24h ?? 0;
  let feeEquivalent24h = cachedMetrics?.fee_equivalent_24h ?? 0;
  let rebateUpperBound24h = cachedMetrics?.rebate_upper_bound_24h ?? 0;
  let rebatePoolPctEffective = cachedMetrics?.rebate_pool_pct ?? (feeEquivalent24h > 0 ? rebateUpperBound24h / feeEquivalent24h : 0);

  if (!cachedMetrics) {
    const volumeRow = sqlite
      .prepare(
        `SELECT
           COALESCE(SUM(f.price * f.size), 0) as volume
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE f.ts >= @since
           AND f.method != 'synthetic_fill'
           AND o.kind IN ('MAKER_BID','MAKER_ASK')
           ${walletId != null ? "AND o.wallet_id = @walletId" : ""}`
      )
      .get(walletId != null ? { since: since24h, walletId } : { since: since24h }) as
      | { volume: number }
      | undefined;

    makerVolume24h = volumeRow?.volume ?? 0;

    const feeRows = sqlite
      .prepare(
        `SELECT
           f.price as price,
           f.size as size,
           t.fee_rate_bps as feeRateBps,
           m.question as marketQuestion,
           m.slug as marketSlug,
           e.title as eventTitle,
           m.taker_base_fee as takerBaseFee
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         LEFT JOIN tokens t ON t.id = o.token_id
         LEFT JOIN markets m ON m.id = o.market_id
         LEFT JOIN market_events e ON e.id = m.event_id
         WHERE f.ts >= @since
           AND f.method != 'synthetic_fill'
           AND o.kind IN ('MAKER_BID','MAKER_ASK')
           ${walletId != null ? "AND o.wallet_id = @walletId" : ""}`
      )
      .all(walletId != null ? { since: since24h, walletId } : { since: since24h }) as Array<{
      price: number | null;
      size: number | null;
      feeRateBps: number | null;
      marketQuestion: string | null;
      marketSlug: string | null;
      eventTitle: string | null;
      takerBaseFee: number | null;
    }>;

    let feeSum = 0;
    let rebateUpper = 0;
    for (const row of feeRows) {
      if (!Number.isFinite(row.price) || !Number.isFinite(row.size)) continue;
      const marketProfile = classifyMarketProfile({
        question: row.marketQuestion,
        slug: row.marketSlug,
        eventTitle: row.eventTitle,
        feeRateBps: row.feeRateBps,
        takerBaseFee: row.takerBaseFee
      });
      const fee = computeFeeEquivalentUsdc({
        marketProfile,
        shares: row.size as number,
        price: row.price as number,
        feeRateBps: row.feeRateBps
      });
      if (Number.isFinite(fee) && fee > 0) {
        feeSum += fee;
        rebateUpper += fee * getMakerRebatePoolPct(marketProfile);
      }
    }

    feeEquivalent24h = feeSum;
    rebateUpperBound24h = rebateUpper;
    rebatePoolPctEffective = feeEquivalent24h > 0 ? rebateUpper / feeEquivalent24h : 0;
  }

  const avgMetrics = {
    avg_spread_capture: getShadowSpreadCapture(),
    avg_fill_rate: null,
    avg_q_min: rewardStats.avgQMin
  };
  const shadow = cachedMetrics
    ? {
        openPositions: cachedMetrics.open_positions,
        totalRealized: cachedMetrics.total_realized,
        totalUnrealized: cachedMetrics.total_unrealized,
        netPnl: cachedMetrics.total_realized + cachedMetrics.total_unrealized,
        longExposure: cachedMetrics.long_exposure,
        shortExposure: cachedMetrics.short_exposure,
        fillCount: cachedMetrics.fill_count
      }
    : computeShadowMakerMetrics(sqlite, walletId);
  const longExp = shadow.longExposure;
  const shortExp = shadow.shortExposure;
  const totalRealized = shadow.totalRealized;
  const totalUnrealized = shadow.totalUnrealized;
  const openShadowPositions = shadow.openPositions;
  const shadowFillRate = getShadowFillRate();

  return {
    openPositions: openShadowPositions,
    totalRealized,
    totalUnrealized,
    netPnl: totalRealized + totalUnrealized,
    avgSpreadCapture: avgMetrics.avg_spread_capture,
    avgFillRate: shadowFillRate ?? avgMetrics.avg_fill_rate ?? 0,
    avgQMin: avgMetrics.avg_q_min,
    rewardEligibleRate24h,
    rewardEligibleCount24h,
    rewardTotalCount24h,
    rewardAvgQMin24h,
    makerVolume24h,
    feeEquivalent24h,
    rebateUpperBound24h,
    rebatePoolPct: rebatePoolPctEffective,
    fillCount: shadow.fillCount,
    longExposure: longExp,
    shortExposure: shortExp
  };
};

const computeTimeOutsideBand = (
  sqlite: ReturnType<typeof getDb>["sqlite"],
  walletId: number | null,
  capabilities: WalletLaneCapabilities
): TimeOutsideBandMetric => {
  if (walletId != null && !capabilities.makerEnabled) {
    return { outsideBandCount: 0, totalCount: 0, pct: 0 };
  }
  const windowHours = 24;
  const since = Date.now() - windowHours * 60 * 60 * 1000;
  const idClause = walletId != null ? "AND o.wallet_id = @walletId" : "";
  try {
    const rows = sqlite
      .prepare(
        `SELECT
           SUM(CASE WHEN o.inventory_i_before IS NOT NULL
             AND w.maker_inventory_max_abs > 0
             AND ABS(o.inventory_i_before) > (w.maker_inventory_band * 1.0 / w.maker_inventory_max_abs)
             THEN 1 ELSE 0 END) as outside_band,
           SUM(CASE WHEN o.inventory_i_before IS NOT NULL THEN 1 ELSE 0 END) as total
         FROM shadow_orders o
         JOIN wallets w ON w.id = o.wallet_id
         WHERE o.kind IN ('MAKER_BID','MAKER_ASK') AND o.ts >= @since ${idClause}`
      )
      .all(walletId != null ? { since, walletId } : { since }) as Array<{ outside_band: number | null; total: number | null }>;
    const row = rows[0];
    const outsideBandCount = Number(row?.outside_band ?? 0) || 0;
    const totalCount = Number(row?.total ?? 0) || 0;
    const pct = totalCount > 0 ? (outsideBandCount / totalCount) * 100 : 0;
    return { outsideBandCount, totalCount, pct };
  } catch {
    return { outsideBandCount: 0, totalCount: 0, pct: 0 };
  }
};

const computeSkipBreakdown = (
  sqlite: ReturnType<typeof getDb>["sqlite"],
  walletId: number | null
): SkipBreakdown => {
  const windowHours = 24;
  const since = Date.now() - windowHours * 60 * 60 * 1000;
  const out: SkipBreakdown = { inventory_build: 0, net_edge_le_0: 0 };
  try {
    const rows = sqlite
      .prepare(
        `SELECT decision_reason, COUNT(*) as cnt
         FROM (
           SELECT decision_reason, wallet_id as walletId
           FROM decision_log
           WHERE decision = 'SKIP' AND ts >= @since
           ORDER BY id DESC
           LIMIT ${DECISION_LOG_RECENT_LIMIT}
         )
         WHERE (@walletId IS NULL OR walletId = @walletId)
         GROUP BY decision_reason`
      )
      .all({ since, walletId: walletId ?? null }) as Array<{ decision_reason: string | null; cnt: number }>;
    for (const r of rows) {
      const key = r.decision_reason ?? "unknown";
      out[key] = (out[key] ?? 0) + r.cnt;
    }
    return out;
  } catch {
    return out;
  }
};

const FEED_STALE_SEC = 120;
const MAKER_STALL_SEC = 180;
const TAKER_STALL_WITH_SIGNALS_SEC = 900;
const MAKER_ACTIVE_SEC = 45;
const TAKER_ACTIVE_SEC = 180;

const maxTs = (...values: Array<number | null>): number | null => {
  let out: number | null = null;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (out == null || (value as number) > out) out = value as number;
  }
  return out;
};

const toAgeSec = (now: number, ts: number | null): number | null => {
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((now - (ts as number)) / 1000));
};

const tableExists = (
  sqlite: ReturnType<typeof getDb>["sqlite"],
  tableName: string
): boolean => {
  try {
    const row = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { name?: string } | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
  }
};

const columnExists = (
  sqlite: ReturnType<typeof getDb>["sqlite"],
  tableName: string,
  columnName: string
): boolean => {
  try {
    const rows = sqlite
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name?: string }>;
    return rows.some((r) => r.name === columnName);
  } catch {
    return false;
  }
};

const classifyLaneHealth = (args: {
  lane: "maker" | "taker";
  feedFreshnessSec: number | null;
  expectActivity: boolean;
  stallSec: number;
  activeSec: number;
  health: Omit<LaneRuntimeHealth, "status" | "reason">;
}): LaneRuntimeHealth => {
  const {
    lane,
    feedFreshnessSec,
    expectActivity,
    stallSec,
    activeSec,
    health
  } = args;

  const hasAnyData = Boolean(
    health.lastOrderTs != null ||
      health.lastOrderTouchTs != null ||
      health.lastRealFillTs != null ||
      health.lastSkipTs != null ||
      health.orders30m > 0 ||
      health.realFills30m > 0 ||
      health.skips30m > 0
  );
  const recentActivity = health.orders5m + health.realFills5m + health.skips5m;

  if (feedFreshnessSec != null && feedFreshnessSec > FEED_STALE_SEC) {
    return {
      ...health,
      status: "stalled",
      reason: `market data stale (${feedFreshnessSec}s)`
    };
  }

  if (health.heartbeatTs == null) {
    return {
      ...health,
      status: hasAnyData ? "idle" : "no_data",
      reason: hasAnyData ? `${lane} quiet (no heartbeat)` : `no ${lane} telemetry yet`
    };
  }

  if (health.sinceHeartbeatSec != null && health.sinceHeartbeatSec > stallSec && expectActivity) {
    return {
      ...health,
      status: "stalled",
      reason: `no ${lane} heartbeat for ${health.sinceHeartbeatSec}s`
    };
  }

  if (recentActivity > 0 || (health.sinceHeartbeatSec != null && health.sinceHeartbeatSec <= activeSec)) {
    return {
      ...health,
      status: "running",
      reason: "recent activity observed"
    };
  }

  if (!expectActivity) {
    return {
      ...health,
      status: "idle",
      reason: lane === "taker" ? "no fresh signals; taker idle" : "maker idle"
    };
  }

  return {
    ...health,
    status: "idle",
    reason: `${lane} running but quiet`
  };
};

const computeRuntimeHealth = (
  sqlite: ReturnType<typeof getDb>["sqlite"],
  walletId: number | null,
  capabilities: WalletLaneCapabilities
): RuntimeHealth => {
  const now = Date.now();
  const since5m = now - 5 * 60 * 1000;
  const since30m = now - 30 * 60 * 1000;
  const orderWalletClause = walletId != null ? "AND o.wallet_id = @walletId" : "";
  const decisionWalletClause = walletId != null ? "AND d.wallet_id = @walletId" : "";

  const hasLastUpdateTs = columnExists(sqlite, "shadow_orders", "last_update_ts");
  const touchExpr = hasLastUpdateTs ? "COALESCE(o.last_update_ts, o.ts)" : "o.ts";

  const countOrdersSince = (kinds: string[], since: number): number => {
    try {
      const row = sqlite
        .prepare(
          `SELECT COUNT(*) as c
           FROM shadow_orders o
           WHERE o.ts >= @since
             AND o.execution_mode = 'SHADOW'
             AND o.kind IN (${kinds.map((k) => `'${k}'`).join(",")})
             ${orderWalletClause}`
        )
        .get(walletId != null ? { since, walletId } : { since }) as { c: number } | undefined;
      return Number(row?.c ?? 0) || 0;
    } catch {
      return 0;
    }
  };

  const countRealFillsSince = (kinds: string[], since: number): number => {
    try {
      const row = sqlite
        .prepare(
          `SELECT COUNT(*) as c
           FROM shadow_fills f
           JOIN shadow_orders o ON o.id = f.order_id
           WHERE f.ts >= @since
             AND f.method != 'synthetic_fill'
             AND o.execution_mode = 'SHADOW'
             AND o.kind IN (${kinds.map((k) => `'${k}'`).join(",")})
             ${orderWalletClause}`
        )
        .get(walletId != null ? { since, walletId } : { since }) as { c: number } | undefined;
      return Number(row?.c ?? 0) || 0;
    } catch {
      return 0;
    }
  };

  const recentSkips = (() => {
    try {
      return sqlite
        .prepare(
          `SELECT d.ts as ts, d.kind as kind, d.wallet_id as walletId
           FROM decision_log d
           WHERE d.decision = 'SKIP'
           ORDER BY d.id DESC
           LIMIT ${RUNTIME_SKIP_ROW_LIMIT}`
        )
        .all() as Array<{ ts: number | null; kind: string | null; walletId: number | null }>;
    } catch {
      return [] as Array<{ ts: number | null; kind: string | null; walletId: number | null }>;
    }
  })();

  const scopedSkips = walletId == null
    ? recentSkips
    : recentSkips.filter((row) => Number(row.walletId) === walletId);

  const countSkipsSince = (kinds: string[], since: number): number => {
    if (!Number.isFinite(since) || scopedSkips.length === 0) return 0;
    const kindSet = new Set(kinds);
    let count = 0;
    for (const row of scopedSkips) {
      if (!Number.isFinite(row.ts) || row.kind == null) continue;
      if ((row.ts as number) < since) continue;
      if (kindSet.has(row.kind)) count += 1;
    }
    return count;
  };

  const maxOrderTs = (kinds: string[]): number | null => {
    try {
      const row = sqlite
        .prepare(
          `SELECT MAX(o.ts) as ts
           FROM shadow_orders o
           WHERE o.execution_mode = 'SHADOW'
             AND o.kind IN (${kinds.map((k) => `'${k}'`).join(",")})
             ${orderWalletClause}`
        )
        .get(walletId != null ? { walletId } : {}) as { ts: number | null } | undefined;
      return row?.ts ?? null;
    } catch {
      return null;
    }
  };

  const maxOrderTouchTs = (kinds: string[]): number | null => {
    try {
      const row = sqlite
        .prepare(
          `SELECT MAX(${touchExpr}) as ts
           FROM shadow_orders o
           WHERE o.execution_mode = 'SHADOW'
             AND o.kind IN (${kinds.map((k) => `'${k}'`).join(",")})
             ${orderWalletClause}`
        )
        .get(walletId != null ? { walletId } : {}) as { ts: number | null } | undefined;
      return row?.ts ?? null;
    } catch {
      return null;
    }
  };

  const maxRealFillTs = (kinds: string[]): number | null => {
    try {
      const row = sqlite
        .prepare(
          `SELECT MAX(f.ts) as ts
           FROM shadow_fills f
           JOIN shadow_orders o ON o.id = f.order_id
           WHERE f.method != 'synthetic_fill'
             AND o.execution_mode = 'SHADOW'
             AND o.kind IN (${kinds.map((k) => `'${k}'`).join(",")})
             ${orderWalletClause}`
        )
        .get(walletId != null ? { walletId } : {}) as { ts: number | null } | undefined;
      return row?.ts ?? null;
    } catch {
      return null;
    }
  };

  const maxSkipTs = (kinds: string[]): number | null => {
    if (scopedSkips.length === 0) return null;
    const kindSet = new Set(kinds);
    let maxTsValue: number | null = null;
    for (const row of scopedSkips) {
      if (!Number.isFinite(row.ts) || row.kind == null) continue;
      if (!kindSet.has(row.kind)) continue;
      const ts = row.ts as number;
      if (maxTsValue == null || ts > maxTsValue) {
        maxTsValue = ts;
      }
    }
    return maxTsValue;
  };

  const latestFeatureTs = (() => {
    try {
      const row = sqlite
        .prepare("SELECT MAX(ts) as ts FROM latest_features")
        .get() as { ts: number | null } | undefined;
      return row?.ts ?? null;
    } catch {
      return null;
    }
  })();

  const feedFreshnessSec = toAgeSec(now, latestFeatureTs);

  const signals5m = (() => {
    try {
      const row = sqlite
        .prepare(
          `SELECT COUNT(*) as c
           FROM decision_log d
           WHERE d.ts >= @since
             AND d.decision = 'SUBMIT'
             AND d.kind IN ('TAKER_BUY', 'TAKER_SELL')
             ${decisionWalletClause}`
        )
        .get(walletId != null ? { since: since5m, walletId } : { since: since5m }) as
        | { c: number }
        | undefined;
      return Number(row?.c ?? 0) || 0;
    } catch {
      return 0;
    }
  })();

  const shadowSummaryUpdatedTs = (() => {
    try {
      if (!tableExists(sqlite, "shadow_summary_latest")) return null;
      const row = sqlite
        .prepare("SELECT updated_ts as ts FROM shadow_summary_latest WHERE id = 1")
        .get() as { ts: number | null } | undefined;
      return row?.ts ?? null;
    } catch {
      return null;
    }
  })();

  const makerKinds = ["MAKER_BID", "MAKER_ASK"];
  const takerKinds = ["TAKER_BUY", "TAKER_SELL"];
  const noDataLane = (reason: string): LaneRuntimeHealth => ({
    status: "no_data",
    reason,
    heartbeatTs: null,
    lastOrderTs: null,
    lastOrderTouchTs: null,
    lastRealFillTs: null,
    lastSkipTs: null,
    sinceHeartbeatSec: null,
    sinceOrderSec: null,
    sinceRealFillSec: null,
    orders5m: 0,
    realFills5m: 0,
    skips5m: 0,
    orders30m: 0,
    realFills30m: 0,
    skips30m: 0
  });

  const maker = capabilities.makerEnabled
    ? (() => {
        const makerLastOrderTs = maxOrderTs(makerKinds);
        const makerLastOrderTouchTs = maxOrderTouchTs(makerKinds);
        const makerLastRealFillTs = maxRealFillTs(makerKinds);
        const makerLastSkipTs = maxSkipTs(makerKinds);
        const makerHeartbeatTs = maxTs(
          makerLastOrderTouchTs,
          makerLastSkipTs,
          makerLastOrderTs,
          makerLastRealFillTs
        );
        const makerBase: Omit<LaneRuntimeHealth, "status" | "reason"> = {
          heartbeatTs: makerHeartbeatTs,
          lastOrderTs: makerLastOrderTs,
          lastOrderTouchTs: makerLastOrderTouchTs,
          lastRealFillTs: makerLastRealFillTs,
          lastSkipTs: makerLastSkipTs,
          sinceHeartbeatSec: toAgeSec(now, makerHeartbeatTs),
          sinceOrderSec: toAgeSec(now, makerLastOrderTs),
          sinceRealFillSec: toAgeSec(now, makerLastRealFillTs),
          orders5m: countOrdersSince(makerKinds, since5m),
          realFills5m: countRealFillsSince(makerKinds, since5m),
          skips5m: countSkipsSince(makerKinds, since5m),
          orders30m: countOrdersSince(makerKinds, since30m),
          realFills30m: countRealFillsSince(makerKinds, since30m),
          skips30m: countSkipsSince(makerKinds, since30m)
        };
        return classifyLaneHealth({
          lane: "maker",
          feedFreshnessSec,
          expectActivity: feedFreshnessSec == null || feedFreshnessSec <= FEED_STALE_SEC,
          stallSec: MAKER_STALL_SEC,
          activeSec: MAKER_ACTIVE_SEC,
          health: makerBase
        });
      })()
    : noDataLane("maker disabled for wallet");

  const taker = capabilities.takerEnabled
    ? (() => {
        const takerLastOrderTs = maxOrderTs(takerKinds);
        const takerLastOrderTouchTs = maxOrderTouchTs(takerKinds);
        const takerLastRealFillTs = maxRealFillTs(takerKinds);
        const takerLastSkipTs = maxSkipTs(takerKinds);
        const takerHeartbeatTs = maxTs(
          takerLastOrderTouchTs,
          takerLastSkipTs,
          takerLastOrderTs,
          takerLastRealFillTs
        );
        const takerBase: Omit<LaneRuntimeHealth, "status" | "reason"> = {
          heartbeatTs: takerHeartbeatTs,
          lastOrderTs: takerLastOrderTs,
          lastOrderTouchTs: takerLastOrderTouchTs,
          lastRealFillTs: takerLastRealFillTs,
          lastSkipTs: takerLastSkipTs,
          sinceHeartbeatSec: toAgeSec(now, takerHeartbeatTs),
          sinceOrderSec: toAgeSec(now, takerLastOrderTs),
          sinceRealFillSec: toAgeSec(now, takerLastRealFillTs),
          orders5m: countOrdersSince(takerKinds, since5m),
          realFills5m: countRealFillsSince(takerKinds, since5m),
          skips5m: countSkipsSince(takerKinds, since5m),
          orders30m: countOrdersSince(takerKinds, since30m),
          realFills30m: countRealFillsSince(takerKinds, since30m),
          skips30m: countSkipsSince(takerKinds, since30m)
        };
        return classifyLaneHealth({
          lane: "taker",
          feedFreshnessSec,
          expectActivity:
            (feedFreshnessSec == null || feedFreshnessSec <= FEED_STALE_SEC) &&
            signals5m > 0,
          stallSec: TAKER_STALL_WITH_SIGNALS_SEC,
          activeSec: TAKER_ACTIVE_SEC,
          health: takerBase
        });
      })()
    : noDataLane("taker disabled for wallet");

  let status: RuntimeHealth["status"] = "running";
  let reason = "runtime healthy";

  if (maker.status === "no_data" && taker.status === "no_data") {
    status = "no_data";
    reason = "no runtime telemetry yet";
  } else if (feedFreshnessSec != null && feedFreshnessSec > FEED_STALE_SEC) {
    status = "stalled";
    reason = `market data stale (${feedFreshnessSec}s)`;
  } else if (maker.status === "stalled" || taker.status === "stalled") {
    status = "degraded";
    const stalled = [maker.status === "stalled" ? "maker" : null, taker.status === "stalled" ? "taker" : null]
      .filter((x): x is string => x != null)
      .join(", ");
    reason = `stalled lane(s): ${stalled}`;
  } else if (maker.status === "idle" && taker.status === "idle") {
    status = "running";
    reason = "lanes idle (no recent executions)";
  }

  return {
    nowTs: now,
    status,
    reason,
    latestFeatureTs,
    feedFreshnessSec,
    signals5m,
    shadowSummaryUpdatedTs,
    shadowSummaryAgeSec: toAgeSec(now, shadowSummaryUpdatedTs),
    maker,
    taker
  };
};

const consolidateMetrics = (
  taker: TakerSystemMetrics,
  maker: MakerSystemMetrics,
  timeOutsideBand: TimeOutsideBandMetric,
  skipBreakdown: SkipBreakdown,
  runtimeHealth: RuntimeHealth,
  alpha: ConsolidatedMetrics["alpha"]
): ConsolidatedMetrics => {
  const totalRealized = taker.realizedPnl + maker.totalRealized;
  const totalUnrealized = maker.totalUnrealized + taker.unrealizedPnl;
  const netPnl = totalRealized + totalUnrealized;

  const totalTrades = taker.fillCount + maker.fillCount;
  const winCount = taker.winCount;
  const lossCount = taker.lossCount;
  const winRate = taker.closedPositions > 0 ? taker.winRate : 0;

  const longExposure = maker.longExposure + taker.longExposure;
  const shortExposure = maker.shortExposure + taker.shortExposure;
  const totalExposure = longExposure + shortExposure;
  const inventorySkew = totalExposure > 0 ? (longExposure - shortExposure) / totalExposure : 0;

  return {
    totalRealized,
    totalUnrealized,
    netPnl,
    totalTrades,
    winCount,
    lossCount,
    winRate,
    longExposure,
    shortExposure,
    inventorySkew,
    avgHoldSec: taker.avgHoldSec,
    avgFillRate: maker.avgFillRate,
    avgSpreadCapture: maker.avgSpreadCapture,
    taker,
    maker,
    timeOutsideBand,
    skipBreakdown,
    runtimeHealth,
    alpha,
    ts: Date.now()
  };
};

export function getPerformanceMetrics(
  sqlite: ReturnType<typeof getDb>["sqlite"],
  walletId: number | null
): ConsolidatedMetrics {
  const capabilities = resolveWalletLaneCapabilities(sqlite, walletId);
  const taker = computeTakerMetrics(sqlite, walletId, capabilities);
  const maker = computeMakerMetrics(sqlite, walletId, capabilities);
  const timeOutsideBand = computeTimeOutsideBand(sqlite, walletId, capabilities);
  const skipBreakdown = computeSkipBreakdown(sqlite, walletId);
  const runtimeHealth = computeRuntimeHealth(sqlite, walletId, capabilities);
  const alpha = computeAlphaPayload(sqlite, walletId);
  return consolidateMetrics(taker, maker, timeOutsideBand, skipBreakdown, runtimeHealth, alpha);
}
