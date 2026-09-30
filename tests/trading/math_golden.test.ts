import { describe, expect, it } from "vitest";
import {
  applyShadowFillToState,
  computeShadowPositionUnrealizedPnl,
  createShadowPositionState
} from "../../packages/data/src/shadowPositionLedger";
import { decideMakerExpectedEv, decideTakerSideEdges } from "../../apps/worker/src/trading/DecisionEngine";
import { computeBasketCostBps } from "../../apps/worker/src/trading/CostModel";
import {
  computeLiquidityOrderScore,
  computeTakerFee,
  selectFeeSchedule
} from "../../apps/worker/src/trading/PolymarketFeeMath";
import { reconcileEvents } from "./independent_cash_ledger";

const zeroCosts = {
  slippageBps: 0,
  adverseSelectionBps: 0,
  queueLossBps: 0,
  inventoryPenaltyBps: 0
};

describe("math assurance golden fixtures from the reviewed plan", () => {
  it("G01 charges no second spread after an executable BUY quote", () => {
    const [buy] = decideTakerSideEdges({
      pHat: 0.55,
      midPx: 0.5,
      bidPx: 0.49,
      askPx: 0.51,
      spreadPx: 0.02,
      sizeShares: 100,
      marketProfile: "CRYPTO_15M",
      feeRateBps: 0,
      minNetEdgeBps: 0,
      ...zeroCosts
    });
    expect(buy?.side).toBe("BUY");
    expect(buy?.predEdgeBps).toBeCloseTo(800, 10);
    expect(buy?.netEdgeBps).toBeCloseTo(800, 10);
  });

  it("G02 counts maker quote edge exactly once", () => {
    const result = decideMakerExpectedEv({
      side: "BUY",
      pHat: 0.5,
      midPx: 0.5,
      quotePx: 0.49,
      spreadPx: 0.02,
      sizeShares: 100,
      marketProfile: "CRYPTO_15M",
      feeRateBps: 0,
      expectedRebateBps: 0,
      expectedLiquidityRewardsBps: 0,
      fillProbability: 1,
      minExpectedEvBps: 0,
      ...zeroCosts
    });
    expect(result.ok).toBe(true);
    expect(result.expectedEvBps).toBeCloseTo(200, 10);
  });

  it("G03 normalizes net cash value once on midpoint reference notional", () => {
    const cashSchedule = { ...selectFeeSchedule({ marketProfile: "CRYPTO_15M" }), paymentAsset: "USDC" as const };
    const [buy] = decideTakerSideEdges({
      pHat: 0.65,
      midPx: 0.5,
      bidPx: 0.49,
      askPx: 0.6,
      spreadPx: 0.11,
      sizeShares: 100,
      marketProfile: "CRYPTO_15M",
      feeRateBps: 10000 / 24,
      feeSchedule: cashSchedule,
      minNetEdgeBps: 0,
      ...zeroCosts
    });
    expect(buy?.predEdgeBps).toBeCloseTo(1000, 10);
    expect(buy?.cost.feeUsdc).toBe(1);
    expect(buy?.cost.feeBps).toBeCloseTo(200, 10);
    expect(buy?.netEdgeBps).toBeCloseTo(800, 10);

    const [sell] = decideTakerSideEdges({
      pHat: 0.35,
      midPx: 0.5,
      bidPx: 0.4,
      askPx: 0.51,
      spreadPx: 0.11,
      sizeShares: 100,
      marketProfile: "CRYPTO_15M",
      feeRateBps: 10000 / 24,
      feeSchedule: cashSchedule,
      minNetEdgeBps: 0,
      ...zeroCosts
    });
    expect(sell?.side).toBe("SELL");
    expect(sell?.cost.feeUsdc).toBe(1);
    expect(sell?.netEdgeBps).toBeCloseTo(800, 10);
  });

  it("G14 values a BUY share fee at the prediction target without a second cash charge", () => {
    const [buy] = decideTakerSideEdges({
      pHat: 0.6,
      midPx: 0.5,
      bidPx: 0.49,
      askPx: 0.5,
      spreadPx: 0.01,
      sizeShares: 100,
      marketProfile: "CRYPTO_15M",
      feeRateBps: 400,
      minNetEdgeBps: 0,
      ...zeroCosts
    });
    expect(buy?.cost.feeUsdc).toBe(1);
    expect(buy?.cost.feeEconomicValueUsdc).toBeCloseTo(1.2, 10);
    expect(buy?.netEdgeBps).toBeCloseTo(1760, 10);
  });

  it("G04-G05 uses current cash-fee rule and honors explicit zero", () => {
    expect(computeTakerFee({ marketProfile: "CRYPTO_15M", shares: 100, price: 0.5, side: "BUY" }).feeUsdc).toBe(1.75);
    expect(
      computeTakerFee({
        marketProfile: "CRYPTO_15M",
        shares: 100,
        price: 0.5,
        side: "BUY",
        feeRateBps: 0
      }).feeUsdc
    ).toBe(0);
  });

  it("G06 computes dimensionless liquidity score", () => {
    expect(
      computeLiquidityOrderScore({
        midpointPrice: 0.5,
        orderPrice: 0.49,
        sizeShares: 100,
        maxSpreadCents: 3
      })
    ).toBeCloseTo(400 / 9, 10);
  });

  it("a pinned historical fee schedule is required for an as-of computation", () => {
    expect(() =>
      computeTakerFee({
        marketProfile: "CRYPTO_15M",
        shares: 100,
        price: 0.5,
        side: "BUY",
        asOfMs: 1
      })
    ).toThrow("MISSING_FEE_SCHEDULE");
    const schedule = {
      ...selectFeeSchedule({ marketProfile: "CRYPTO_15M" }),
      version: "fixture-historical-v1",
      effectiveFromMs: 0,
      effectiveToMs: 1000
    };
    expect(
      computeTakerFee({
        marketProfile: "CRYPTO_15M",
        shares: 100,
        price: 0.5,
        side: "BUY",
        asOfMs: 1,
        schedule
      }).scheduleVersion
    ).toBe("fixture-historical-v1");
    expect(() =>
      computeTakerFee({
        marketProfile: "CRYPTO_15M",
        shares: 100,
        price: 0.5,
        side: "BUY",
        asOfMs: 1000,
        schedule
      })
    ).toThrow("MISSING_FEE_SCHEDULE");
    expect(() =>
      computeTakerFee({
        marketProfile: "CRYPTO_15M",
        shares: 100,
        price: 0.5,
        side: "BUY",
        asOfMs: 1,
        schedule: { ...schedule, effectiveToMs: null }
      })
    ).toThrow("MISSING_FEE_SCHEDULE");
  });

  it("G07 rejects nonfinite maker belief and fill probability", () => {
    const base = {
      side: "BUY" as const,
      pHat: 0.53,
      midPx: 0.5,
      quotePx: 0.5,
      spreadPx: 0,
      sizeShares: 100,
      marketProfile: "CRYPTO_15M" as const,
      feeRateBps: 0,
      expectedRebateBps: 0,
      expectedLiquidityRewardsBps: 0,
      fillProbability: 0.5,
      minExpectedEvBps: 0,
      ...zeroCosts
    };
    expect(decideMakerExpectedEv({ ...base, pHat: NaN }).ok).toBe(false);
    expect(decideMakerExpectedEv({ ...base, fillProbability: NaN }).ok).toBe(false);
  });

  it("G08 conditions fill-dependent maker economics on filling", () => {
    const result = decideMakerExpectedEv({
      side: "BUY",
      pHat: 0.53,
      midPx: 0.5,
      quotePx: 0.5,
      spreadPx: 0,
      sizeShares: 100,
      marketProfile: "CRYPTO_15M",
      feeRateBps: 0,
      slippageBps: 10,
      adverseSelectionBps: 10,
      queueLossBps: 10,
      inventoryPenaltyBps: 0,
      expectedRebateBps: 10,
      expectedLiquidityRewardsBps: 0,
      fillProbability: 0,
      minExpectedEvBps: 0
    });
    expect(result.expectedEvBps).toBe(0);
  });

  it("G09 separates conditional costs from standing and submission terms", () => {
    const result = decideMakerExpectedEv({
      side: "BUY",
      pHat: 0.53,
      midPx: 0.5,
      quotePx: 0.5,
      spreadPx: 0,
      sizeShares: 100,
      marketProfile: "CRYPTO_15M",
      feeRateBps: 0,
      slippageBps: 80,
      adverseSelectionBps: 0,
      queueLossBps: 0,
      inventoryPenaltyBps: 0,
      expectedRebateBps: 20,
      expectedLiquidityRewardsBps: 40,
      submissionCostBps: 10,
      fillProbability: 0.25,
      minExpectedEvBps: 0
    });
    expect(result.ok).toBe(true);
    expect(result.predEdgeBps).toBeCloseTo(600, 10);
    expect(result.expectedEvBps).toBeCloseTo(165, 10);
  });

  it("G10-G11 preserves basis through a partial close", () => {
    const initial = createShadowPositionState(1, "YES");
    const bought = applyShadowFillToState(initial, {
      walletId: 1,
      tokenId: "YES",
      side: "BUY",
      price: 0.4,
      size: 100,
      ts: 1
    });
    const partial = applyShadowFillToState(bought, {
      walletId: 1,
      tokenId: "YES",
      side: "SELL",
      price: 0.6,
      size: 40,
      ts: 2
    });
    expect(partial.position).toBe(60);
    expect(partial.avgEntry).toBe(0.4);
    expect(partial.realizedPnl).toBeCloseTo(8, 10);
    expect(computeShadowPositionUnrealizedPnl(partial, 0.5)).toBeCloseTo(6, 10);
    const flat = applyShadowFillToState(partial, {
      walletId: 1,
      tokenId: "YES",
      side: "SELL",
      price: 0.5,
      size: 60,
      ts: 3
    });
    expect(flat.position).toBe(0);
    expect(flat.realizedPnl).toBeCloseTo(14, 10);
  });

  it("preserves basis under a supported synthetic short reduction and resets it on a flip", () => {
    const opened = applyShadowFillToState(createShadowPositionState(1, "YES"), {
      walletId: 1,
      tokenId: "YES",
      side: "SELL",
      price: 0.6,
      size: 100,
      ts: 1
    });
    const reduced = applyShadowFillToState(opened, {
      walletId: 1,
      tokenId: "YES",
      side: "BUY",
      price: 0.4,
      size: 40,
      ts: 2
    });
    expect(reduced.position).toBe(-60);
    expect(reduced.avgEntry).toBe(0.6);
    expect(reduced.realizedPnl).toBeCloseTo(8, 10);
    const flipped = applyShadowFillToState(reduced, {
      walletId: 1,
      tokenId: "YES",
      side: "BUY",
      price: 0.5,
      size: 70,
      ts: 3
    });
    expect(flipped.position).toBe(10);
    expect(flipped.avgEntry).toBe(0.5);
    expect(flipped.realizedPnl).toBeCloseTo(14, 10);
  });

  it("G12 recognizes a valid zero-valued mark", () => {
    expect(computeShadowPositionUnrealizedPnl({ position: 100, avgEntry: 0.4 }, 0)).toBe(-40);
    expect(computeShadowPositionUnrealizedPnl({ position: 100, avgEntry: 0.4 }, null)).toBeNull();
    expect(computeShadowPositionUnrealizedPnl({ position: 100, avgEntry: 0.4 }, NaN)).toBeNull();
    expect(computeShadowPositionUnrealizedPnl({ position: NaN, avgEntry: 0.4 }, 0.5)).toBeNull();
  });

  it("G16 adds basket cash costs before using the common capital base", () => {
    const cashSchedule = { ...selectFeeSchedule({ marketProfile: "CRYPTO_15M" }), paymentAsset: "USDC" as const };
    expect(
      computeBasketCostBps({
        legs: [
          {
            side: "BUY",
            midPx: 0.2,
            quotePx: 0.2,
            spreadPx: 0,
            sizeShares: 100,
            marketProfile: "CRYPTO_15M",
            feeRateBps: 625,
            feeSchedule: cashSchedule
          },
          {
            side: "BUY",
            midPx: 0.8,
            quotePx: 0.8,
            spreadPx: 0,
            sizeShares: 100,
            marketProfile: "CRYPTO_15M",
            feeRateBps: 625,
            feeSchedule: cashSchedule
          }
        ],
        slippageBpsPerLeg: 0,
        adverseSelectionBpsPerLeg: 0,
        queueLossBpsPerLeg: 0,
        inventoryPenaltyBps: 0,
        referenceCapitalUsdc: 100
      })
    ).toBeCloseTo(200, 10);
  });

  it("G13 reconciles entry cash, weighted basis, gross and net realized profit", () => {
    const ledger = reconcileEvents(
      [
        {
          id: "a",
          sequence: 1,
          kind: "FILL",
          token: "YES",
          side: "BUY",
          shares: 30,
          price: 0.4,
          feeAsset: "CASH",
          feeAmount: 0.03
        },
        {
          id: "b",
          sequence: 2,
          kind: "FILL",
          token: "YES",
          side: "BUY",
          shares: 20,
          price: 0.42,
          feeAsset: "CASH",
          feeAmount: 0.02
        },
        {
          id: "c",
          sequence: 3,
          kind: "FILL",
          token: "YES",
          side: "SELL",
          shares: 50,
          price: 0.45,
          feeAsset: "CASH",
          feeAmount: 0.05
        }
      ],
      {}
    );
    expect(ledger.grossRealized).toBeCloseTo(2.1, 10);
    expect(ledger.cashFees).toBeCloseTo(0.1, 10);
    expect(ledger.netPnl).toBeCloseTo(2, 10);
    expect(ledger.positions.get("YES")?.shares).toBe(0);
  });

  it("G14 charges a synthetic share fee in shares exactly once", () => {
    const ledger = reconcileEvents(
      [
        {
          id: "buy",
          sequence: 1,
          kind: "FILL",
          token: "YES",
          side: "BUY",
          shares: 100,
          price: 0.5,
          feeAsset: "SHARES",
          feeAmount: 2
        }
      ],
      { YES: 0.6 }
    );
    expect(ledger.positions.get("YES")?.shares).toBe(98);
    expect(ledger.cash).toBe(-50);
    expect(ledger.netPnl).toBeCloseTo(8.8, 10);
  });

  it("G15 settles a matched binary set and excludes transfers from income", () => {
    const ledger = reconcileEvents(
      [
        { id: "deposit", sequence: 0, kind: "TRANSFER", amount: 100 },
        {
          id: "yes",
          sequence: 1,
          kind: "FILL",
          token: "YES",
          side: "BUY",
          shares: 100,
          price: 0.47,
          feeAsset: "CASH",
          feeAmount: 0.5
        },
        {
          id: "no",
          sequence: 2,
          kind: "FILL",
          token: "NO",
          side: "BUY",
          shares: 100,
          price: 0.5,
          feeAsset: "CASH",
          feeAmount: 0.5
        },
        { id: "settle_yes", sequence: 3, kind: "SETTLEMENT", token: "YES", payout: 1 },
        { id: "settle_no", sequence: 4, kind: "SETTLEMENT", token: "NO", payout: 0 }
      ],
      {}
    );
    expect(ledger.cash - ledger.transfers).toBeCloseTo(2, 10);
    expect(ledger.netPnl).toBeCloseTo(2, 10);
    expect(ledger.grossRealized).toBeCloseTo(3, 10);
    expect(ledger.cashFees).toBe(1);
  });

  it("G12 transfers a zero terminal mark from unrealized to realized exactly once", () => {
    const buy = {
      id: "buy",
      sequence: 1,
      kind: "FILL",
      token: "YES",
      side: "BUY",
      shares: 100,
      price: 0.4,
      feeAsset: "CASH",
      feeAmount: 0
    } as const;
    const before = reconcileEvents([buy], { YES: 0 });
    const after = reconcileEvents(
      [buy, { id: "settle", sequence: 2, kind: "SETTLEMENT", token: "YES", payout: 0 }],
      {}
    );
    expect(before.netPnl).toBe(-40);
    expect(after.grossRealized).toBe(-40);
    expect(after.positions.get("YES")?.shares).toBe(0);
    expect(after.netPnl).toBe(-40);
  });

  it("deduplicates accepted events and rejects unsupported negative inventory", () => {
    const buy = {
      id: "buy",
      sequence: 1,
      kind: "FILL",
      token: "YES",
      side: "BUY",
      shares: 10,
      price: 0.4,
      feeAsset: "CASH",
      feeAmount: 0
    } as const;
    const ledger = reconcileEvents([buy, buy], { YES: 0.5 });
    expect(ledger.duplicates).toBe(1);
    expect(ledger.positions.get("YES")?.shares).toBe(10);
    expect(() =>
      reconcileEvents(
        [
          {
            id: "sell",
            sequence: 1,
            kind: "FILL",
            token: "YES",
            side: "SELL",
            shares: 1,
            price: 0.5,
            feeAsset: "CASH",
            feeAmount: 0
          }
        ],
        {}
      )
    ).toThrow("UNSUPPORTED_SHORT_OR_FEE");
  });
});
