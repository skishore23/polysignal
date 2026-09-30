import { describe, expect, it } from "vitest";
import {
  decideArbOpportunity,
  decideBestTakerSide,
  decideMakerExpectedEv,
  decideMarketProfileScope,
  decideTakerSideEdges
} from "../../apps/worker/src/trading/DecisionEngine";

describe("DecisionEngine cutover", () => {
  it("selects best taker side using dynamic costs", () => {
    const best = decideBestTakerSide({
      pHat: 0.62,
      midPx: 0.5,
      bidPx: 0.49,
      askPx: 0.51,
      spreadPx: 0.02,
      sizeShares: 100,
      marketProfile: "CRYPTO_15M",
      minNetEdgeBps: 1,
      slippageBps: 1,
      adverseSelectionBps: 1,
      queueLossBps: 0.5,
      inventoryPenaltyBps: 0
    });

    expect(best).not.toBeNull();
    expect(best?.side).toBe("BUY");
    expect(best?.netEdgeBps ?? 0).toBeGreaterThan(1);
  });

  it("returns no side when costs dominate", () => {
    const all = decideTakerSideEdges({
      pHat: 0.51,
      midPx: 0.5,
      bidPx: 0.49,
      askPx: 0.51,
      spreadPx: 0.02,
      sizeShares: 100,
      marketProfile: "CRYPTO_15M",
      minNetEdgeBps: 3,
      slippageBps: 10,
      adverseSelectionBps: 10,
      queueLossBps: 5,
      inventoryPenaltyBps: 5
    });

    expect(all).toHaveLength(0);
  });

  it("includes rebate and rewards in maker EV", () => {
    const blocked = decideMakerExpectedEv({
      side: "BUY",
      pHat: 0.5005,
      midPx: 0.5,
      quotePx: 0.4995,
      spreadPx: 0.001,
      sizeShares: 100,
      marketProfile: "CRYPTO_15M",
      slippageBps: 6,
      adverseSelectionBps: 12,
      queueLossBps: 6,
      expectedRebateBps: 0,
      expectedLiquidityRewardsBps: 0,
      rebateBps: 0,
      inventoryPenaltyBps: 8,
      fillProbability: 0.1,
      minExpectedEvBps: 4
    });

    const allowed = decideMakerExpectedEv({
      side: "BUY",
      pHat: 0.58,
      midPx: 0.5,
      quotePx: 0.49,
      spreadPx: 0.02,
      sizeShares: 100,
      marketProfile: "CRYPTO_15M",
      slippageBps: 1,
      adverseSelectionBps: 1,
      queueLossBps: 0.5,
      expectedRebateBps: 3,
      expectedLiquidityRewardsBps: 1,
      rebateBps: 0,
      inventoryPenaltyBps: 0,
      fillProbability: 0.8,
      minExpectedEvBps: 2
    });

    expect(blocked.ok).toBe(false);
    expect(allowed.ok).toBe(true);
    expect(allowed.expectedEvBps).toBeGreaterThan(2);
  });

  it("fail-closes unknown profile in crypto-only scope", () => {
    const gate = decideMarketProfileScope("UNKNOWN", "PROFILE_KNOWN_ONLY");
    expect(gate.ok).toBe(false);
  });

  it("gates arb by min net edge", () => {
    expect(decideArbOpportunity(2, 3).ok).toBe(false);
    expect(decideArbOpportunity(5, 3).ok).toBe(true);
  });
});
