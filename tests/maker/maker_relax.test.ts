import { describe, expect, it } from "vitest";

import { MakerLoop } from "../../apps/worker/src/maker/MakerLoop";

type MakerLivenessConfig = {
  enabled: boolean;
  lookbackMs: number;
  feedFreshMaxAgeSec: number;
  minOrders5mMaker: number;
  minOrders5mTaker: number;
  relaxDurationMs: number;
  relaxCooldownMs: number;
  maxExploreOrdersPerWindow: number;
  allowInLive: boolean;
};

const makeLoop = (liveness: MakerLivenessConfig): any => {
  const loop = Object.create(MakerLoop.prototype) as any;
  loop.config = {
    executionPolicy: { mode: "PAPER" as const },
    regimeLiveness: liveness
  };
  loop.relaxStateByWallet = new Map();
  return loop;
};

describe.skip("MakerLoop liveness relax", () => {
  it("triggers once per cooldown and exits cleanly when lane recovers", () => {
    const now = Date.now();
    const loop = makeLoop({
      enabled: true,
      lookbackMs: 300_000,
      feedFreshMaxAgeSec: 20,
      minOrders5mMaker: 1,
      minOrders5mTaker: 1,
      relaxDurationMs: 100,
      relaxCooldownMs: 500,
      maxExploreOrdersPerWindow: 3,
      allowInLive: false
    });

    expect((loop as any).isLivenessRelaxActive(7, now, true)).toBe(true);
    expect((loop as any).isLivenessRelaxActive(7, now + 50, true)).toBe(true);
    expect((loop as any).isLivenessRelaxActive(7, now + 150, false)).toBe(false);
    expect((loop as any).isLivenessRelaxActive(7, now + 150, true)).toBe(false);
    expect((loop as any).isLivenessRelaxActive(7, now + 700, true)).toBe(true);
  });

  it("caps explore attempts per relax window", () => {
    const now = Date.now();
    const loop = makeLoop({
      enabled: true,
      lookbackMs: 300_000,
      feedFreshMaxAgeSec: 20,
      minOrders5mMaker: 1,
      minOrders5mTaker: 1,
      relaxDurationMs: 100,
      relaxCooldownMs: 500,
      maxExploreOrdersPerWindow: 2,
      allowInLive: false
    });

    expect((loop as any).isLivenessRelaxActive(9, now, true)).toBe(true);
    expect((loop as any).consumeExploreAttempt(9, now)).toBe(true);
    expect((loop as any).consumeExploreAttempt(9, now)).toBe(true);
    expect((loop as any).consumeExploreAttempt(9, now)).toBe(false);
  });
});
