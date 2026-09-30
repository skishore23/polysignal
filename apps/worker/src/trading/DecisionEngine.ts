import { applyCostToEdge, computeCostBreakdown, type TradeSide } from "./CostModel";
import type { MarketProfile, MarketScope } from "./MarketProfile";
import { isProfileTradableInScope } from "./MarketProfile";
import type { FeeSchedule } from "./PolymarketFeeMath";

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
  feeSchedule?: FeeSchedule;
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
  submissionCostBps?: number;
};

const PASS: DecisionGateResult = { ok: true, reason: "ok" };

const fail = (reason: string): DecisionGateResult => ({ ok: false, reason });

const validProbability = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;

const validPrice = (value: number): boolean => Number.isFinite(value) && value > 0 && value < 1;

const validCosts = (input: {
  slippageBps: number;
  adverseSelectionBps: number;
  queueLossBps: number;
  inventoryPenaltyBps: number;
  feeRateBps?: number | null;
}): boolean =>
  [input.slippageBps, input.adverseSelectionBps, input.queueLossBps, input.inventoryPenaltyBps].every(
    (value) => Number.isFinite(value) && value >= 0
  ) &&
  (input.feeRateBps == null || (Number.isFinite(input.feeRateBps) && input.feeRateBps >= 0));

export const parseCsvAllowlist = (raw: string | null): Set<string> | null => {
  if (!raw) return null;
  const entries = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return entries.length ? new Set(entries) : null;
};

export const decideTakerSideEdges = (input: TakerDecisionInput): SideEdgeDecision[] => {
  if (
    !validProbability(input.pHat) ||
    !validPrice(input.midPx) ||
    !validPrice(input.bidPx) ||
    !validPrice(input.askPx) ||
    input.bidPx > input.askPx ||
    !Number.isFinite(input.spreadPx) ||
    input.spreadPx < 0 ||
    !Number.isFinite(input.sizeShares) ||
    input.sizeShares <= 0 ||
    !Number.isFinite(input.minNetEdgeBps) ||
    !validCosts(input) ||
    input.marketProfile === "UNKNOWN"
  )
    return [];

  const buyPredEdgeBps = ((input.pHat - input.askPx) / input.midPx) * 10_000;
  const sellPredEdgeBps = ((input.bidPx - input.pHat) / input.midPx) * 10_000;
  let buyCost: SideEdgeDecision["cost"];
  let sellCost: SideEdgeDecision["cost"];
  try {
    buyCost = computeCostBreakdown({
      role: "TAKER",
      side: "BUY",
      midPx: input.midPx,
      quotePx: input.askPx,
      spreadPx: input.spreadPx,
      sizeShares: input.sizeShares,
      marketProfile: input.marketProfile,
      feeRateBps: input.feeRateBps,
      feeSchedule: input.feeSchedule,
      expectedValuePerShare: input.pHat,
      slippageBps: input.slippageBps,
      adverseSelectionBps: input.adverseSelectionBps,
      queueLossBps: input.queueLossBps,
      rebateBps: 0,
      inventoryPenaltyBps: input.inventoryPenaltyBps
    });

    sellCost = computeCostBreakdown({
      role: "TAKER",
      side: "SELL",
      midPx: input.midPx,
      quotePx: input.bidPx,
      spreadPx: input.spreadPx,
      sizeShares: input.sizeShares,
      marketProfile: input.marketProfile,
      feeRateBps: input.feeRateBps,
      feeSchedule: input.feeSchedule,
      slippageBps: input.slippageBps,
      adverseSelectionBps: input.adverseSelectionBps,
      queueLossBps: input.queueLossBps,
      rebateBps: 0,
      inventoryPenaltyBps: input.inventoryPenaltyBps
    });
  } catch {
    return [];
  }

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

export const decideMakerExpectedEv = (
  input: MakerEvInput
): DecisionGateResult & {
  expectedEvBps: number;
  predEdgeBps: number;
  costBps: number;
} => {
  if (
    (input.side !== "BUY" && input.side !== "SELL") ||
    !validProbability(input.pHat) ||
    !validPrice(input.midPx) ||
    !validPrice(input.quotePx) ||
    !Number.isFinite(input.spreadPx) ||
    input.spreadPx < 0 ||
    !Number.isFinite(input.sizeShares) ||
    input.sizeShares <= 0 ||
    !validProbability(input.fillProbability) ||
    !Number.isFinite(input.minExpectedEvBps) ||
    !validCosts(input) ||
    !Number.isFinite(input.expectedRebateBps) ||
    input.expectedRebateBps < 0 ||
    !Number.isFinite(input.expectedLiquidityRewardsBps) ||
    input.expectedLiquidityRewardsBps < 0 ||
    (input.rebateBps != null && (!Number.isFinite(input.rebateBps) || input.rebateBps < 0)) ||
    (input.submissionCostBps != null && (!Number.isFinite(input.submissionCostBps) || input.submissionCostBps < 0)) ||
    ((input.rebateBps ?? 0) > 0 && input.expectedRebateBps > 0) ||
    input.marketProfile === "UNKNOWN"
  ) {
    return {
      ok: false,
      reason: "invalid_input",
      expectedEvBps: 0,
      predEdgeBps: 0,
      costBps: 0
    };
  }

  const predEdgeBps =
    input.side === "BUY"
      ? ((input.pHat - input.quotePx) / input.midPx) * 10_000
      : ((input.quotePx - input.pHat) / input.midPx) * 10_000;

  let cost: SideEdgeDecision["cost"];
  try {
    cost = computeCostBreakdown({
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
  } catch {
    return {
      ok: false,
      reason: "missing_or_invalid_cost",
      expectedEvBps: 0,
      predEdgeBps: 0,
      costBps: 0
    };
  }

  // The quote is already in predEdge. Fill-dependent cash flows vanish with no fill;
  // standing rewards and submission/risk terms do not.
  const conditionalCostBps =
    cost.feeBps +
    cost.slippageBps +
    cost.adverseSelectionBps +
    cost.queueLossBps -
    cost.rebateBps -
    cost.expectedRebateBps;
  const costBps =
    input.fillProbability * conditionalCostBps +
    cost.inventoryPenaltyBps +
    (input.submissionCostBps ?? 0) -
    cost.expectedLiquidityRewardsBps;
  const expectedEvBps = input.fillProbability * predEdgeBps - costBps;

  if (!Number.isFinite(expectedEvBps)) {
    return { ok: false, reason: "invalid_economics", expectedEvBps: 0, predEdgeBps: 0, costBps: 0 };
  }

  if (expectedEvBps < input.minExpectedEvBps) {
    return {
      ok: false,
      reason: "maker_ev_below_min",
      expectedEvBps,
      predEdgeBps,
      costBps
    };
  }

  return {
    ...PASS,
    expectedEvBps,
    predEdgeBps,
    costBps
  };
};

export const decideArbOpportunity = (netEdgeBps: number, minNetEdgeBps: number): DecisionGateResult =>
  Number.isFinite(netEdgeBps) && Number.isFinite(minNetEdgeBps) && netEdgeBps >= minNetEdgeBps
    ? PASS
    : fail("arb_net_edge_below_min");

export const decideMarketProfileScope = (profile: MarketProfile, scope: MarketScope): DecisionGateResult => {
  if (profile === "UNKNOWN") return fail("market_profile_unknown_fail_closed");
  return isProfileTradableInScope(profile, scope)
    ? PASS
    : fail(scope === "PROFILE_KNOWN_ONLY" ? "market_profile_not_model_known" : "market_profile_not_tradable");
};
