import { describe, expect, it } from "vitest";

import {
  compileWalletMarketGate,
  evaluateWalletMarketGate,
  normalizeWalletTakerSide
} from "../../apps/worker/src/trading/WalletMarketGate";

describe("wallet market gate", () => {
  it("normalizes taker side safely", () => {
    expect(normalizeWalletTakerSide("buy")).toBe("BUY");
    expect(normalizeWalletTakerSide("SELL")).toBe("SELL");
    expect(normalizeWalletTakerSide("NONE")).toBe("NONE");
    expect(normalizeWalletTakerSide("weird")).toBe("BOTH");
  });

  it("fails closed on invalid JSON filter", () => {
    const gate = compileWalletMarketGate({
      marketFilterJson: "{bad-json"
    });
    const decision = evaluateWalletMarketGate(gate, {
      marketId: "m1",
      marketVolumeUsd: 10_000,
      marketLiquidityUsd: 10_000,
      marketActive: true,
      kind: "TAKER_BUY"
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("wallet_filter_invalid");
  });

  it("applies structured filter constraints only", () => {
    const gate = compileWalletMarketGate({
      marketFilterJson: JSON.stringify({
        version: 1,
        includeMarketIds: ["m1", "m2"],
        minVolumeUsd: 1000,
        allowedKinds: ["TAKER_SELL"]
      })
    });

    const notAllowedKind = evaluateWalletMarketGate(gate, {
      marketId: "m1",
      marketVolumeUsd: 10_000,
      marketLiquidityUsd: 10_000,
      marketActive: true,
      kind: "TAKER_BUY"
    });
    expect(notAllowedKind.ok).toBe(false);
    expect(notAllowedKind.reason).toBe("market_kind_not_allowed");

    const notIncluded = evaluateWalletMarketGate(gate, {
      marketId: "m9",
      marketVolumeUsd: 10_000,
      marketLiquidityUsd: 10_000,
      marketActive: true,
      kind: "TAKER_SELL"
    });
    expect(notIncluded.ok).toBe(false);
    expect(notIncluded.reason).toBe("market_not_included");

    const pass = evaluateWalletMarketGate(gate, {
      marketId: "m2",
      marketVolumeUsd: 50_000,
      marketLiquidityUsd: 10_000,
      marketActive: true,
      kind: "TAKER_SELL"
    });
    expect(pass.ok).toBe(true);
  });
});
