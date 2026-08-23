import { describe, expect, it } from "vitest";

import { validateEdgeCostSanity } from "../../apps/worker/src/trading/EdgeSanity";
import type { CostBreakdown } from "../../packages/types/src";

const baseCost = (): CostBreakdown => ({
  spreadBps: 12,
  feeBps: 25,
  feeUsdc: 0.12,
  feePerShare: 0.0012,
  notionalUsdc: 100,
  marketProfile: "CRYPTO_15M",
  slippageBps: 5,
  adverseSelectionBps: 3,
  queueLossBps: 1,
  expectedRebateBps: 0,
  expectedLiquidityRewardsBps: 0,
  rebateBps: 0,
  inventoryPenaltyBps: 2,
  totalCostBps: 48
});

describe("validateEdgeCostSanity", () => {
  it("accepts reasonable finite values", () => {
    const result = validateEdgeCostSanity({
      predEdgeBps: 120,
      netEdgeBps: 72,
      cost: baseCost()
    });
    expect(result.ok).toBe(true);
  });

  it("rejects absurd edge magnitudes", () => {
    const result = validateEdgeCostSanity({
      predEdgeBps: 50_000,
      netEdgeBps: 49_900,
      cost: baseCost()
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("pred_edge_out_of_range");
  });

  it("rejects cost blowups", () => {
    const result = validateEdgeCostSanity({
      predEdgeBps: 200,
      netEdgeBps: -8_000,
      cost: {
        ...baseCost(),
        totalCostBps: 8_500
      }
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("total_cost_too_high");
  });
});
