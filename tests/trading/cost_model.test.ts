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

    expect(crypto.feeUsdc).toBe(1.75);
    expect(sports.feeUsdc).toBe(1.25);
    expect(crypto.feeBps).toBeCloseTo(350, 10);
    expect(sports.feeBps).toBeCloseTo(250, 10);
  });

  it("uses one midpoint denominator for current crypto round-trip cash fees", () => {
    const buy = computeCostBreakdown({
      role: "TAKER",
      side: "BUY",
      expectedValuePerShare: 0.5,
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

    expect(buy.feeBps + sell.feeBps).toBeCloseTo(700, 10);
  });

  it("applies documented 5-decimal rounding and preserves true zero post-rounding", () => {
    const roundsToMinUnit = computeTakerFee({
      marketProfile: "CRYPTO_15M",
      shares: 0.0003,
      price: 0.5,
      side: "BUY"
    });
    const trueRoundedZero = computeTakerFee({
      marketProfile: "CRYPTO_15M",
      shares: 0.0003,
      price: 0.3,
      side: "BUY"
    });

    expect(roundsToMinUnit.feeUsdc).toBe(0.00001);
    expect(trueRoundedZero.feeUsdc).toBe(0);
  });

  it("rejects unavailable fee metadata instead of assuming a free market", () => {
    expect(() =>
      computeCostBreakdown({
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
      })
    ).toThrow("MISSING_FEE_SCHEDULE");
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
