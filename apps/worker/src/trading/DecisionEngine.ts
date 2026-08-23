import { applyCostToEdge, computeCostBreakdown, type TradeSide } from "./CostModel";
import type { MarketProfile, MarketScope } from "./MarketProfile";
import { isProfileTradableInScope } from "./MarketProfile";

export type DecisionGateResult = {
  ok: boolean;
  reason: string;
};

export type SideEdgeDecision = {
  side: TradeSide;
  predEdgeBps: number;
  netEdgeBps: number;
  cost: ReturnType<typeof computeCostBreakdown>;
};

export type TakerDecisionInput = {
  pHat: number;
  midPx: number;
  bidPx: number;
  askPx: number;
  spreadPx: number;
  sizeShares: number;
  marketProfile: MarketProfile;
  feeRateBps?: number | null;
  minNetEdgeBps: number;
  slippageBps: number;
  adverseSelectionBps: number;
  queueLossBps: number;
  inventoryPenaltyBps: number;
};

export type MakerEvInput = {
  side: TradeSide;
  pHat: number;
  midPx: number;
  quotePx: number;
  spreadPx: number;
  sizeShares: number;
  marketProfile: MarketProfile;
  feeRateBps?: number | null;
  slippageBps: number;
  adverseSelectionBps: number;
  queueLossBps: number;
  rebateBps?: number;
  expectedRebateBps: number;
  expectedLiquidityRewardsBps: number;
  inventoryPenaltyBps: number;
  fillProbability: number;
  minExpectedEvBps: number;
};

const PASS: DecisionGateResult = { ok: true, reason: "ok" };

const fail = (reason: string): DecisionGateResult => ({ ok: false, reason });

export const parseCsvAllowlist = (raw: string | null): Set<string> | null => {
  if (!raw) return null;
  const entries = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return entries.length ? new Set(entries) : null;
};

export const decideTakerSideEdges = (input: TakerDecisionInput): SideEdgeDecision[] => {
  if (!Number.isFinite(input.midPx) || input.midPx <= 0) return [];

  const buyPredEdgeBps = ((input.pHat - input.askPx) / input.midPx) * 10_000;
  const buyCost = computeCostBreakdown({
    role: "TAKER",
    side: "BUY",
    midPx: input.midPx,
    quotePx: input.askPx,
    spreadPx: input.spreadPx,
    sizeShares: input.sizeShares,
    marketProfile: input.marketProfile,
    feeRateBps: input.feeRateBps,
    slippageBps: input.slippageBps,
    adverseSelectionBps: input.adverseSelectionBps,
    queueLossBps: input.queueLossBps,
    rebateBps: 0,
    inventoryPenaltyBps: input.inventoryPenaltyBps
  });

  const sellPredEdgeBps = ((input.bidPx - input.pHat) / input.midPx) * 10_000;
  const sellCost = computeCostBreakdown({
    role: "TAKER",
    side: "SELL",
    midPx: input.midPx,
    quotePx: input.bidPx,
    spreadPx: input.spreadPx,
    sizeShares: input.sizeShares,
    marketProfile: input.marketProfile,
    feeRateBps: input.feeRateBps,
    slippageBps: input.slippageBps,
    adverseSelectionBps: input.adverseSelectionBps,
    queueLossBps: input.queueLossBps,
    rebateBps: 0,
    inventoryPenaltyBps: input.inventoryPenaltyBps
  });

  const buyNet = applyCostToEdge(buyPredEdgeBps, buyCost);
  const sellNet = applyCostToEdge(sellPredEdgeBps, sellCost);

  const out: SideEdgeDecision[] = [];
  if (buyNet >= input.minNetEdgeBps) {
    out.push({
      side: "BUY",
      predEdgeBps: buyPredEdgeBps,
      netEdgeBps: buyNet,
      cost: buyCost
    });
  }
  if (sellNet >= input.minNetEdgeBps) {
    out.push({
      side: "SELL",
      predEdgeBps: sellPredEdgeBps,
      netEdgeBps: sellNet,
      cost: sellCost
    });
  }
  return out.sort((a, b) => b.netEdgeBps - a.netEdgeBps);
};

export const decideBestTakerSide = (input: TakerDecisionInput): SideEdgeDecision | null => {
  const sides = decideTakerSideEdges(input);
  return sides[0] ?? null;
};

export const decideMakerExpectedEv = (input: MakerEvInput): DecisionGateResult & {
  expectedEvBps: number;
  predEdgeBps: number;
  costBps: number;
} => {
  if (!Number.isFinite(input.midPx) || input.midPx <= 0) {
    return {
      ok: false,
      reason: "invalid_mid",
      expectedEvBps: 0,
      predEdgeBps: 0,
      costBps: 0
    };
  }

  const predEdgeBps = input.side === "BUY"
    ? ((input.pHat - input.quotePx) / input.midPx) * 10_000
    : ((input.quotePx - input.pHat) / input.midPx) * 10_000;

  const cost = computeCostBreakdown({
    role: "MAKER",
    side: input.side,
    midPx: input.midPx,
    quotePx: input.quotePx,
    spreadPx: input.spreadPx,
    sizeShares: input.sizeShares,
    marketProfile: input.marketProfile,
    feeRateBps: input.feeRateBps,
    slippageBps: input.slippageBps,
    adverseSelectionBps: input.adverseSelectionBps,
    queueLossBps: input.queueLossBps,
    rebateBps: input.rebateBps,
    expectedRebateBps: input.expectedRebateBps,
    expectedLiquidityRewardsBps: input.expectedLiquidityRewardsBps,
    inventoryPenaltyBps: input.inventoryPenaltyBps
  });

  const halfSpreadCaptureBps = Math.max(0, (Math.abs(input.quotePx - input.midPx) / input.midPx) * 10_000);
  const expectedGrossBps = predEdgeBps + halfSpreadCaptureBps;
  const expectedEvBps = input.fillProbability * expectedGrossBps - cost.totalCostBps;

  if (expectedEvBps < input.minExpectedEvBps) {
    return {
      ok: false,
      reason: "maker_ev_below_min",
      expectedEvBps,
      predEdgeBps,
      costBps: cost.totalCostBps
    };
  }

  return {
    ...PASS,
    expectedEvBps,
    predEdgeBps,
    costBps: cost.totalCostBps
  };
};

export const decideArbOpportunity = (netEdgeBps: number, minNetEdgeBps: number): DecisionGateResult =>
  netEdgeBps >= minNetEdgeBps
    ? PASS
    : fail("arb_net_edge_below_min");

export const decideMarketProfileScope = (
  profile: MarketProfile,
  scope: MarketScope
): DecisionGateResult => {
  if (profile === "UNKNOWN") return fail("market_profile_unknown_fail_closed");
  return isProfileTradableInScope(profile, scope)
    ? PASS
    : fail(scope === "PROFILE_KNOWN_ONLY" ? "market_profile_not_model_known" : "market_profile_not_tradable");
};
