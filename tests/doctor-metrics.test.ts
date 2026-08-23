import { describe, expect, it } from "vitest";
import {
  computeMarkoutBps,
  computeSpreadBpsFromBidAsk,
  reconstructCycles
} from "../scripts/lib/metrics.js";

describe("doctor metrics invariants", () => {
  it("enforces markout sign conventions for BUY and SELL", () => {
    expect(computeMarkoutBps("BUY", 0.5, 0.52)).toBeGreaterThan(0);
    expect(computeMarkoutBps("BUY", 0.5, 0.48)).toBeLessThan(0);
    expect(computeMarkoutBps("SELL", 0.5, 0.48)).toBeGreaterThan(0);
    expect(computeMarkoutBps("SELL", 0.5, 0.52)).toBeLessThan(0);
  });

  it("computes spread_bps as (ask-bid)/mid * 1e4", () => {
    const bid = 0.49;
    const ask = 0.51;
    const mid = 0.5;
    const expected = ((ask - bid) / mid) * 10_000;
    expect(computeSpreadBpsFromBidAsk(bid, ask, mid)).toBeCloseTo(expected, 10);
    expect(Number.isNaN(computeSpreadBpsFromBidAsk(bid, ask, 0))).toBe(true);
  });

  it("reconstructs cycles and handles close+flip transitions", () => {
    const result = reconstructCycles([
      {
        fillId: 1,
        ts: 1_000,
        walletId: 1,
        tokenId: "token-a",
        side: "BUY",
        price: 100,
        size: 1
      },
      {
        fillId: 2,
        ts: 2_000,
        walletId: 1,
        tokenId: "token-a",
        side: "SELL",
        price: 110,
        size: 2
      },
      {
        fillId: 3,
        ts: 3_000,
        walletId: 1,
        tokenId: "token-a",
        side: "BUY",
        price: 90,
        size: 1
      }
    ]);

    expect(result.anomalies).toHaveLength(0);
    expect(result.cycles).toHaveLength(2);

    const first = result.cycles[0];
    const second = result.cycles[1];
    expect(first?.realizedPnl).toBeCloseTo(10, 10);
    expect(first?.direction).toBe("LONG");
    expect(second?.realizedPnl).toBeCloseTo(20, 10);
    expect(second?.direction).toBe("SHORT");
    expect(result.openStates).toHaveLength(0);
  });
});
