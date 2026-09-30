import { describe, expect, it } from "vitest";
import { applyShadowFillToState, createShadowPositionState } from "../../packages/data/src/shadowPositionLedger";
import { decideMakerExpectedEv } from "../../apps/worker/src/trading/DecisionEngine";
import { computeLiquidityOrderScore, computeTakerFee } from "../../apps/worker/src/trading/PolymarketFeeMath";

let seed = 0x20260930;
const random = (): number => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 2 ** 32;
};
const close = (actual: number, expected: number): void =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12 + 1e-10 * Math.abs(expected));

describe("economic properties with a frozen seed", () => {
  it("preserves quote/midpoint decomposition, fee symmetry, score units and reduction basis", () => {
    for (let i = 0; i < 1000; i += 1) {
      const mid = 0.1 + random() * 0.8;
      const quote = Math.min(0.99, mid + random() * (1 - mid) * 0.1);
      const value = random();
      const size = 1 + random() * 200;
      const direct = size * (value - quote);
      const decomposition = size * (value - mid) - size * (quote - mid);
      close(direct, decomposition);

      const p = 0.01 + random() * 0.98;
      const feeA = computeTakerFee({
        marketProfile: "CRYPTO_15M",
        shares: size,
        price: p,
        side: "SELL"
      }).feeUsdc;
      const feeB = computeTakerFee({
        marketProfile: "CRYPTO_15M",
        shares: size,
        price: 1 - p,
        side: "SELL"
      }).feeUsdc;
      close(feeA, feeB);

      const spread = 1 + random() * 10;
      const distance = random() * spread;
      const scoreA = computeLiquidityOrderScore({
        midpointPrice: 0.5,
        orderPrice: 0.5 - distance / 100,
        sizeShares: size,
        maxSpreadCents: spread
      });
      const scoreB = computeLiquidityOrderScore({
        midpointPrice: 0.5,
        orderPrice: 0.5 - distance / 200,
        sizeShares: size,
        maxSpreadCents: spread / 2
      });
      close(scoreA, scoreB);

      const entry = 0.01 + random() * 0.98;
      const bought = applyShadowFillToState(createShadowPositionState(1, "YES"), {
        walletId: 1,
        tokenId: "YES",
        side: "BUY",
        price: entry,
        size,
        ts: 1
      });
      const partial = applyShadowFillToState(bought, {
        walletId: 1,
        tokenId: "YES",
        side: "SELL",
        price: p,
        size: size / 2,
        ts: 2
      });
      close(partial.avgEntry, entry);
      close(partial.position, size / 2);
    }
  });

  it("makes fill-dependent economics vanish at zero fills and costs monotone", () => {
    for (let i = 0; i < 1000; i += 1) {
      const base = {
        side: "BUY" as const,
        pHat: 0.53,
        midPx: 0.5,
        quotePx: 0.5,
        spreadPx: 0,
        sizeShares: 100,
        marketProfile: "CRYPTO_15M" as const,
        feeRateBps: 0,
        slippageBps: random() * 50,
        adverseSelectionBps: random() * 50,
        queueLossBps: random() * 50,
        rebateBps: 0,
        expectedRebateBps: 0,
        expectedLiquidityRewardsBps: 0,
        inventoryPenaltyBps: 0,
        minExpectedEvBps: -1000
      };
      const noFill = decideMakerExpectedEv({ ...base, fillProbability: 0 });
      expect(noFill.expectedEvBps).toBe(0);
      const low = decideMakerExpectedEv({ ...base, fillProbability: 0.5 });
      const high = decideMakerExpectedEv({
        ...base,
        fillProbability: 0.5,
        slippageBps: base.slippageBps + 1
      });
      expect(high.expectedEvBps).toBeLessThan(low.expectedEvBps);
    }
  });
});
