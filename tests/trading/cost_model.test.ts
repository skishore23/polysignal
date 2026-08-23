import { describe, expect, it } from "vitest";
import { computeCostBreakdown } from "../../apps/worker/src/trading/CostModel";
import { computeTakerFee } from "../../apps/worker/src/trading/PolymarketFeeMath";

describe("CostModel dynamic Polymarket fees", () => {
  it("matches 15m crypto and sports effective fee rates at p=0.5", () => {
    const crypto = computeTakerFee({
      marketProfile: "CRYPTO_15M",
      shares: 100,
      price: 0.5,
      side: "BUY"
    });
    const sports = computeTakerFee({
      marketProfile: "SPORTS",
      shares: 100,
      price: 0.5,
      side: "BUY"
    });

    expect(crypto.feeBps).toBeCloseTo(156.26, 2); // rounded fee => 1.5626%
    expect(sports.feeBps).toBeCloseTo(43.76, 2); // rounded fee => 0.4376%
  });

  it("reflects round-trip taker intuition around ~3.125% at 50c for crypto", () => {
    const buy = computeCostBreakdown({
      role: "TAKER",
      side: "BUY",
      midPx: 0.5,
      quotePx: 0.5,
      spreadPx: 0,
      sizeShares: 100,
      marketProfile: "CRYPTO_15M",
      slippageBps: 0,
      adverseSelectionBps: 0,
      queueLossBps: 0,
      inventoryPenaltyBps: 0
    });
    const sell = computeCostBreakdown({
      role: "TAKER",
      side: "SELL",
      midPx: 0.5,
      quotePx: 0.5,
      spreadPx: 0,
      sizeShares: 100,
      marketProfile: "CRYPTO_15M",
      slippageBps: 0,
      adverseSelectionBps: 0,
      queueLossBps: 0,
      inventoryPenaltyBps: 0
    });

    expect(buy.feeBps + sell.feeBps).toBeCloseTo(312.52, 2);
  });

  it("applies 4-decimal rounding and preserves true zero post-rounding", () => {
    const roundsToMinUnit = computeTakerFee({
      marketProfile: "CRYPTO_15M",
      shares: 0.01,
      price: 0.5,
      side: "BUY"
    });
    const trueRoundedZero = computeTakerFee({
      marketProfile: "CRYPTO_15M",
      shares: 0.01,
      price: 0.3,
      side: "BUY"
    });

    expect(roundsToMinUnit.feeUsdc).toBe(0.0001);
    expect(trueRoundedZero.feeUsdc).toBe(0);
  });

  it("produces zero taker fee for unknown profile (fail-closed economics)", () => {
    const cost = computeCostBreakdown({
      role: "TAKER",
      side: "BUY",
      midPx: 0.5,
      quotePx: 0.5,
      spreadPx: 0,
      sizeShares: 10,
      marketProfile: "UNKNOWN",
      slippageBps: 0,
      adverseSelectionBps: 0,
      queueLossBps: 0,
      inventoryPenaltyBps: 0
    });
    expect(cost.feeBps).toBe(0);
    expect(cost.feeUsdc).toBe(0);
  });

  it("computes taker fees for CRYPTO_5M profile in shadow mode", () => {
    const fee = computeTakerFee({
      marketProfile: "CRYPTO_5M",
      shares: 100,
      price: 0.5,
      side: "BUY",
      feeRateBps: 1000
    });
    expect(fee.feeBps).toBeGreaterThan(0);
    expect(fee.feeUsdc).toBeGreaterThan(0);
  });
});
