import type { CostBreakdown } from "@polysignal/types";
import type { MarketProfile } from "./MarketProfile";
import { computeTakerFee } from "./PolymarketFeeMath";

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
  }>;
  slippageBpsPerLeg: number;
  adverseSelectionBpsPerLeg: number;
  queueLossBpsPerLeg: number;
  rebateBpsPerLeg?: number;
  inventoryPenaltyBps: number;
};

const bps = (x: number): number => x * 10_000;

const clamp = (value: number, min = 0): number =>
  Number.isFinite(value) ? Math.max(min, value) : min;

const computeSpreadCostBps = (input: Pick<CostModelInput, "role" | "side" | "midPx" | "quotePx" | "spreadPx">): number => {
  if (!Number.isFinite(input.midPx) || input.midPx <= 0) return 0;
  if (input.role === "MAKER") return 0;
  if (input.side === "BUY") {
    return clamp(bps((input.quotePx - input.midPx) / input.midPx));
  }
  return clamp(bps((input.midPx - input.quotePx) / input.midPx));
};

export const computeCostBreakdown = (input: CostModelInput): CostBreakdown => {
  const spreadBps = computeSpreadCostBps(input);
  const takerFee = input.role === "TAKER"
    ? computeTakerFee({
        marketProfile: input.marketProfile,
        shares: input.sizeShares,
        price: input.quotePx,
        side: input.side,
        feeRateBps: input.feeRateBps
      })
    : {
        feeUsdc: 0,
        feePerShare: 0,
        feeBps: 0,
        notionalUsdc: Math.max(0, input.sizeShares * input.quotePx)
      };

  const feeBps = clamp(takerFee.feeBps);
  const feeUsdc = clamp(takerFee.feeUsdc);
  const feePerShare = clamp(takerFee.feePerShare);
  const notionalUsdc = clamp(takerFee.notionalUsdc);
  const slippageBps = clamp(input.slippageBps);
  const adverseSelectionBps = clamp(input.adverseSelectionBps);
  const queueLossBps = clamp(input.queueLossBps);
  const legacyRebateBps = clamp(input.rebateBps ?? 0);
  const expectedRebateBps = clamp(input.expectedRebateBps ?? 0);
  const expectedLiquidityRewardsBps = clamp(input.expectedLiquidityRewardsBps ?? 0);
  const inventoryPenaltyBps = clamp(input.inventoryPenaltyBps);

  const totalCostBps =
    spreadBps +
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
  predictedEdgeBps - cost.totalCostBps;

export const computeBasketCostBps = (input: BasketCostInput): number => {
  let total = clamp(input.inventoryPenaltyBps);
  for (const leg of input.legs) {
    const legCost = computeCostBreakdown({
      role: "TAKER",
      side: leg.side,
      midPx: leg.midPx,
      quotePx: leg.quotePx,
      spreadPx: leg.spreadPx,
      sizeShares: leg.sizeShares,
      marketProfile: leg.marketProfile,
      feeRateBps: leg.feeRateBps,
      slippageBps: input.slippageBpsPerLeg,
      adverseSelectionBps: input.adverseSelectionBpsPerLeg,
      queueLossBps: input.queueLossBpsPerLeg,
      rebateBps: input.rebateBpsPerLeg,
      inventoryPenaltyBps: 0
    });
    total += legCost.totalCostBps;
  }
  return total;
};
