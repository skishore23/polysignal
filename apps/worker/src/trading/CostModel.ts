import type { CostBreakdown } from "@polysignal/types";
import type { MarketProfile } from "./MarketProfile";
import { computeTakerFee } from "./PolymarketFeeMath";
import type { FeeSchedule } from "./PolymarketFeeMath";

export type TradeSide = "BUY" | "SELL";
export type TradeRole = "TAKER" | "MAKER";

export type CostModelInput = {
  role: TradeRole;
  side: TradeSide;
  midPx: number;
  quotePx: number;
  spreadPx: number;
  sizeShares: number;
  marketProfile: MarketProfile;
  feeRateBps?: number | null;
  feeSchedule?: FeeSchedule;
  /** Required for BUY share-fee valuation; must name the same target as predicted edge. */
  expectedValuePerShare?: number;
  slippageBps: number;
  adverseSelectionBps: number;
  queueLossBps: number;
  rebateBps?: number;
  expectedRebateBps?: number;
  expectedLiquidityRewardsBps?: number;
  inventoryPenaltyBps: number;
};

export type BasketCostInput = {
  legs: Array<{
    side: TradeSide;
    midPx: number;
    quotePx: number;
    spreadPx: number;
    sizeShares: number;
    marketProfile: MarketProfile;
    feeRateBps?: number | null;
    feeSchedule?: FeeSchedule;
    expectedValuePerShare?: number;
  }>;
  slippageBpsPerLeg: number;
  adverseSelectionBpsPerLeg: number;
  queueLossBpsPerLeg: number;
  rebateBpsPerLeg?: number;
  inventoryPenaltyBps: number;
  /** Positive capital base shared by all legs; defaults to sum of midpoint notionals. */
  referenceCapitalUsdc?: number;
};

const bps = (x: number): number => x * 10_000;

const nonnegative = (value: number | undefined, name: string, optional = false): number => {
  if (value == null) {
    if (optional) return 0;
    throw new Error(`MISSING_${name}`);
  }
  if (!Number.isFinite(value) || value < 0) throw new Error(`INVALID_${name}`);
  return value;
};

const computeSpreadCostBps = (
  input: Pick<CostModelInput, "role" | "side" | "midPx" | "quotePx" | "spreadPx">
): number => {
  if (!Number.isFinite(input.midPx) || input.midPx <= 0) throw new Error("INVALID_MID_PRICE");
  if (input.role === "MAKER") return 0;
  if (input.side === "BUY") {
    return Math.max(0, bps((input.quotePx - input.midPx) / input.midPx));
  }
  return Math.max(0, bps((input.midPx - input.quotePx) / input.midPx));
};

export const computeCostBreakdown = (input: CostModelInput): CostBreakdown => {
  if (
    !Number.isFinite(input.midPx) ||
    input.midPx <= 0 ||
    input.midPx >= 1 ||
    !Number.isFinite(input.quotePx) ||
    input.quotePx <= 0 ||
    input.quotePx >= 1 ||
    !Number.isFinite(input.sizeShares) ||
    input.sizeShares <= 0 ||
    !Number.isFinite(input.spreadPx) ||
    input.spreadPx < 0 ||
    (input.role !== "TAKER" && input.role !== "MAKER") ||
    (input.side !== "BUY" && input.side !== "SELL") ||
    (input.feeRateBps != null && (!Number.isFinite(input.feeRateBps) || input.feeRateBps < 0))
  ) {
    throw new Error("INVALID_COST_INPUT");
  }
  const referenceNotionalUsdc = input.midPx * input.sizeShares;
  const spreadBps = computeSpreadCostBps(input);
  const takerFee =
    input.role === "TAKER"
      ? computeTakerFee({
          marketProfile: input.marketProfile,
          shares: input.sizeShares,
          price: input.quotePx,
          side: input.side,
          feeRateBps: input.feeRateBps,
          schedule: input.feeSchedule
        })
      : {
          feeUsdc: 0,
          feePerShare: 0,
          feeBps: 0,
          sharesFee: 0,
          notionalUsdc: Math.max(0, input.sizeShares * input.quotePx)
        };

  const feeUsdc = takerFee.feeUsdc;
  let feeEconomicValueUsdc = feeUsdc;
  if (input.role === "TAKER" && input.side === "BUY" && takerFee.sharesFee > 0) {
    if (
      input.expectedValuePerShare == null ||
      !Number.isFinite(input.expectedValuePerShare) ||
      input.expectedValuePerShare < 0 ||
      input.expectedValuePerShare > 1
    ) {
      throw new Error("MISSING_VALUE_FOR_SHARE_FEE");
    }
    feeEconomicValueUsdc = takerFee.sharesFee * input.expectedValuePerShare;
  }
  const feeBps = bps(feeEconomicValueUsdc / referenceNotionalUsdc);
  const feePerShare = takerFee.feePerShare;
  const notionalUsdc = takerFee.notionalUsdc;
  const slippageBps = nonnegative(input.slippageBps, "SLIPPAGE");
  const adverseSelectionBps = nonnegative(input.adverseSelectionBps, "ADVERSE_SELECTION");
  const queueLossBps = nonnegative(input.queueLossBps, "QUEUE_LOSS");
  const legacyRebateBps = nonnegative(input.rebateBps, "REBATE", true);
  const expectedRebateBps = nonnegative(input.expectedRebateBps, "EXPECTED_REBATE", true);
  const expectedLiquidityRewardsBps = nonnegative(input.expectedLiquidityRewardsBps, "LIQUIDITY_REWARDS", true);
  const inventoryPenaltyBps = nonnegative(input.inventoryPenaltyBps, "INVENTORY_PENALTY");

  const totalCostBps =
    feeBps +
    slippageBps +
    adverseSelectionBps +
    queueLossBps +
    inventoryPenaltyBps -
    legacyRebateBps -
    expectedRebateBps -
    expectedLiquidityRewardsBps;

  return {
    spreadBps,
    feeBps,
    feeUsdc,
    feeEconomicValueUsdc,
    feePerShare,
    notionalUsdc,
    marketProfile: input.marketProfile,
    slippageBps,
    adverseSelectionBps,
    queueLossBps,
    expectedRebateBps,
    expectedLiquidityRewardsBps,
    rebateBps: legacyRebateBps,
    inventoryPenaltyBps,
    totalCostBps
  };
};

export const applyCostToEdge = (predictedEdgeBps: number, cost: CostBreakdown): number =>
  Number.isFinite(predictedEdgeBps) && Number.isFinite(cost.totalCostBps)
    ? predictedEdgeBps - cost.totalCostBps
    : -Infinity;

export const computeBasketCostBps = (input: BasketCostInput): number => {
  if (!input.legs.length) return Infinity;
  let totalCostUsdc = 0;
  let defaultCapitalUsdc = 0;
  for (const leg of input.legs) {
    let legCost: CostBreakdown;
    try {
      legCost = computeCostBreakdown({
        role: "TAKER",
        side: leg.side,
        midPx: leg.midPx,
        quotePx: leg.quotePx,
        spreadPx: leg.spreadPx,
        sizeShares: leg.sizeShares,
        marketProfile: leg.marketProfile,
        feeRateBps: leg.feeRateBps,
        feeSchedule: leg.feeSchedule,
        expectedValuePerShare: leg.expectedValuePerShare,
        slippageBps: input.slippageBpsPerLeg,
        adverseSelectionBps: input.adverseSelectionBpsPerLeg,
        queueLossBps: input.queueLossBpsPerLeg,
        rebateBps: input.rebateBpsPerLeg,
        inventoryPenaltyBps: 0
      });
    } catch {
      return Infinity;
    }
    const legReferenceUsdc = leg.midPx * leg.sizeShares;
    defaultCapitalUsdc += legReferenceUsdc;
    totalCostUsdc += (legCost.totalCostBps * legReferenceUsdc) / 10_000;
  }
  const capital = input.referenceCapitalUsdc ?? defaultCapitalUsdc;
  if (!Number.isFinite(capital) || capital <= 0) return Infinity;
  try {
    return bps(totalCostUsdc / capital) + nonnegative(input.inventoryPenaltyBps, "INVENTORY_PENALTY");
  } catch {
    return Infinity;
  }
};
