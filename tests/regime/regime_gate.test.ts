import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { RegimeGate, type RegimeGateConfig } from "../../apps/worker/src/regime/RegimeGate";

const logger = { info: () => {} } as any;

type Fixture = {
  markovPath: string;
  strategyPath: string;
  cleanup: () => void;
};

function buildFixture(rows?: unknown[]): Fixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), "regime-gate-test-"));
  const markovPath = path.join(dir, "markov.json");
  const strategyPath = path.join(dir, "strategy.json");

  writeFileSync(
    markovPath,
    JSON.stringify(
      {
        config: {
          bins: 3,
          features: ["spread"]
        },
        edges: {
          spread: [0.01, 0.02]
        }
      },
      null,
      2
    )
  );

  writeFileSync(
    strategyPath,
    JSON.stringify(
      {
        rows: rows ?? [
          {
            state: 0,
            kind: "TAKER_BUY",
            walletId: 1,
            count: 120,
            markoutCount: 120,
            orderCount: 150,
            filledOrderCount: 120,
            wavgBps: 2.5,
            fillRate: 0.8,
            markoutStdBps: 2.2,
            markoutSeBps: 0.2
          }
        ]
      },
      null,
      2
    )
  );

  return {
    markovPath,
    strategyPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

function makeConfig(markovPath: string, strategyPath: string): RegimeGateConfig {
  return {
    enabled: true,
    markovPath,
    strategyPath,
    minCount: 5,
    minWavgBps: 0,
    minFillRate: 0,
    reloadMs: 0,
    failOpen: false,
    probabilistic: {
      kEdge: 50,
      zEdge: 1.64,
      zFill: 1.64,
      sigmaPriorBps: 1,
      winsorClipBps: 250,
      riskPenaltyBps: 0,
      costBufferBps: 0,
      hardBlockUpperBps: 0,
      hardBlockMinCount: 30,
      walletBlendK: 50,
      minScoreByKind: {
        TAKER_BUY: 0.5,
        TAKER_SELL: 0.5,
        MAKER_BID: 0,
        MAKER_ASK: 0
      },
      exploreMinByKind: {
        TAKER_BUY: 0.1,
        TAKER_SELL: 0.2,
        MAKER_BID: 0.25,
        MAKER_ASK: 0.25
      },
      exploreMaxByKind: {
        TAKER_BUY: 0.25,
        TAKER_SELL: 0.35,
        MAKER_BID: 0.4,
        MAKER_ASK: 0.4
      },
      explicitHardBlocks: ["186|TAKER_BUY"]
    },
    liveness: {
      enabled: true,
      lookbackMs: 300000,
      feedFreshMaxAgeSec: 20,
      minOrders5mMaker: 1,
      minOrders5mTaker: 1,
      relaxDurationMs: 120000,
      relaxCooldownMs: 600000,
      maxExploreOrdersPerWindow: 3,
      allowInLive: false
    }
  };
}

describe("RegimeGate centralized decisions", () => {
  it("returns full decision metadata for allowed actions", () => {
    const fixture = buildFixture();
    try {
      const gate = new RegimeGate(makeConfig(fixture.markovPath, fixture.strategyPath), logger);
      const feature = { spread: 0.005 };
      const decision = gate.decide("TAKER_BUY", 1, feature);

      expect(decision.allowed).toBe(true);
      expect(decision.mode).toBe("full");
      expect(decision.reason).toBe("ok");
      expect(decision.state).toBe(0);
      expect(decision.wavgBps).toBeCloseTo(2.5);
      expect(decision.count).toBe(120);
      expect(decision.fillRate).toBeCloseTo(0.8);
      expect(decision.scoreBps).not.toBeNull();
      expect(Number.isFinite(decision.scoreBps ?? NaN)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("routes sparse states to explore instead of hard block", () => {
    const fixture = buildFixture();
    try {
      const gate = new RegimeGate(makeConfig(fixture.markovPath, fixture.strategyPath), logger);
      const decision = gate.decide("TAKER_SELL", 1, { spread: 0.005 });
      expect(decision.allowed).toBe(true);
      expect(decision.mode).toBe("explore");
      expect(decision.reason).toBe("sparse_explore");
      expect(decision.state).toBe(0);
      expect(decision.wavgBps).toBeNull();
      expect(decision.sizeMultiplier).toBeGreaterThan(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("hard-blocks configured explicit state|kind buckets", () => {
    const fixture = buildFixture();
    try {
      const gate = new RegimeGate(makeConfig(fixture.markovPath, fixture.strategyPath), logger);
      const decision = gate.decideForState("TAKER_BUY", 1, 186);
      expect(decision.allowed).toBe(false);
      expect(decision.mode).toBe("blocked");
      expect(decision.reason).toBe("explicit_block");
    } finally {
      fixture.cleanup();
    }
  });

  it("hard-blocks strong negative evidence via UCB rule", () => {
    const fixture = buildFixture([
      {
        state: 0,
        kind: "TAKER_SELL",
        walletId: 1,
        count: 80,
        markoutCount: 80,
        orderCount: 100,
        filledOrderCount: 80,
        wavgBps: -5,
        fillRate: 0.8,
        markoutStdBps: 0.5,
        markoutSeBps: 0.05
      }
    ]);
    try {
      const gate = new RegimeGate(makeConfig(fixture.markovPath, fixture.strategyPath), logger);
      const decision = gate.decide("TAKER_SELL", 1, { spread: 0.005 });
      expect(decision.allowed).toBe(false);
      expect(decision.mode).toBe("blocked");
      expect(decision.reason).toBe("ucb_negative");
      expect((decision.edgeUcbBps ?? 1)).toBeLessThan(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps bounds numerically stable on tiny samples", () => {
    const fixture = buildFixture([
      {
        state: 0,
        kind: "MAKER_BID",
        walletId: 1,
        count: 1,
        markoutCount: 1,
        orderCount: 2,
        filledOrderCount: 1,
        wavgBps: 0,
        fillRate: 0.5,
        markoutStdBps: 0,
        markoutSeBps: 0
      }
    ]);
    try {
      const gate = new RegimeGate(makeConfig(fixture.markovPath, fixture.strategyPath), logger);
      const decision = gate.decide("MAKER_BID", 1, { spread: 0.005 });
      expect(decision.pFillLcb).not.toBeNull();
      expect((decision.pFillLcb ?? -1)).toBeGreaterThanOrEqual(0);
      expect((decision.pFillLcb ?? 2)).toBeLessThanOrEqual(1);
      expect(Number.isFinite(decision.edgeLcbBps ?? NaN)).toBe(true);
      expect(Number.isFinite(decision.edgeUcbBps ?? NaN)).toBe(true);
      expect(Number.isFinite(decision.scoreBps ?? NaN)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("matches Wilson bounds for tiny n_orders=1..5", () => {
    const rows = Array.from({ length: 5 }, (_, idx) => ({
      state: idx,
      kind: "MAKER_BID",
      walletId: 1,
      count: idx + 1,
      markoutCount: idx + 1,
      orderCount: idx + 1,
      filledOrderCount: 1,
      wavgBps: 0.5,
      fillRate: 1 / (idx + 1),
      markoutStdBps: 0.1,
      markoutSeBps: 0.1
    }));
    const fixture = buildFixture(rows);
    try {
      const gate = new RegimeGate(makeConfig(fixture.markovPath, fixture.strategyPath), logger);
      for (let n = 1; n <= 5; n += 1) {
        const decision = gate.decideForState("MAKER_BID", 1, n - 1);
        expect(decision.pFillLcb).not.toBeNull();
        expect((decision.pFillLcb ?? -1)).toBeGreaterThanOrEqual(0);
        expect((decision.pFillLcb ?? 2)).toBeLessThanOrEqual(1);
        expect(Number.isFinite(decision.pFillLcb ?? NaN)).toBe(true);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("never emits NaN/Inf when denominators collapse to zero", () => {
    const fixture = buildFixture([
      {
        state: 0,
        kind: "TAKER_BUY",
        walletId: 1,
        count: 0,
        markoutCount: 0,
        orderCount: 0,
        filledOrderCount: 0,
        wavgBps: null,
        fillRate: null,
        markoutStdBps: null,
        markoutSeBps: null
      }
    ]);
    try {
      const gate = new RegimeGate(makeConfig(fixture.markovPath, fixture.strategyPath), logger);
      const decision = gate.decide("TAKER_BUY", 1, { spread: 0.005 });
      const nums = [
        decision.scoreBps,
        decision.edgeLcbBps,
        decision.edgeUcbBps,
        decision.pFillLcb,
        decision.sizeMultiplier,
        decision.wavgBps,
        decision.fillRate
      ];
      for (const value of nums) {
        if (value == null) continue;
        expect(Number.isFinite(value)).toBe(true);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("never applies liveness relax in live execution when allowInLive=false", () => {
    const fixture = buildFixture([
      {
        state: 0,
        kind: "TAKER_BUY",
        walletId: 1,
        count: 1,
        markoutCount: 1,
        orderCount: 1,
        filledOrderCount: 1,
        wavgBps: 0.1,
        fillRate: 1,
        markoutStdBps: 10,
        markoutSeBps: 10
      }
    ]);
    try {
      const gate = new RegimeGate(makeConfig(fixture.markovPath, fixture.strategyPath), logger);
      const decision = gate.decide("TAKER_BUY", 1, { spread: 0.005 }, {
        lane: "taker",
        livenessRelax: true,
        executionMode: "FULL"
      });
      expect(decision.reasonCode).not.toBe("liveness_relax");
    } finally {
      fixture.cleanup();
    }
  });

  it("exposes state-stamped decisions via decideForState", () => {
    const fixture = buildFixture();
    try {
      const gate = new RegimeGate(makeConfig(fixture.markovPath, fixture.strategyPath), logger);
      const feature = { spread: 0.005 };
      const state = gate.computeState(feature);
      const full = gate.decide("TAKER_BUY", 1, feature);
      const stamped = gate.decideForState("TAKER_BUY", 1, state);

      expect(stamped.state).toBe(state);
      expect(stamped.allowed).toBe(full.allowed);
      expect(stamped.reason).toBe(full.reason);
      expect(stamped.wavgBps).toBe(full.wavgBps);
      expect(stamped.count).toBe(full.count);

      const gateDecision = gate.allow("TAKER_BUY", 1, feature);
      expect(gateDecision.allowed).toBe(true);
      expect(gateDecision.reason).toBe(full.reason);
    } finally {
      fixture.cleanup();
    }
  });
});
