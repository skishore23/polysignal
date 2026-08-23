import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { RegimeGate, type RegimeGateConfig } from "../../apps/worker/src/regime/RegimeGate";

const logger = { info: () => {} } as any;

type Fixture = {
  dir: string;
  markovPath: string;
  strategyPath: string;
  manifestPath: string;
  cleanup: () => void;
};

const writeSnapshot = (fixture: Fixture, stamp: string, wavgBps: number): void => {
  writeFileSync(
    fixture.markovPath,
    JSON.stringify(
      {
        _meta: { stamp, generatedAt: new Date().toISOString() },
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
    fixture.strategyPath,
    JSON.stringify(
      {
        _meta: { stamp, generatedAt: new Date().toISOString() },
        rows: [
          {
            state: 0,
            kind: "TAKER_BUY",
            walletId: 1,
            count: 80,
            markoutCount: 80,
            orderCount: 100,
            filledOrderCount: 80,
            wavgBps,
            fillRate: 0.8,
            markoutStdBps: 1,
            markoutSeBps: 0.2
          }
        ]
      },
      null,
      2
    )
  );
  writeFileSync(
    fixture.manifestPath,
    JSON.stringify(
      {
        stamp,
        generatedAt: new Date().toISOString(),
        markovFile: path.basename(fixture.markovPath),
        strategyFile: path.basename(fixture.strategyPath)
      },
      null,
      2
    )
  );
};

const buildFixture = (): Fixture => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "regime-gate-pair-test-"));
  return {
    dir,
    markovPath: path.join(dir, "markov_regime.json"),
    strategyPath: path.join(dir, "strategy_regime_report.json"),
    manifestPath: path.join(dir, "regime_manifest.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
};

const makeConfig = (fixture: Fixture): RegimeGateConfig => ({
  enabled: true,
  markovPath: fixture.markovPath,
  strategyPath: fixture.strategyPath,
  manifestPath: fixture.manifestPath,
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
    minScoreByKind: { TAKER_BUY: 0.1, TAKER_SELL: 0.1, MAKER_BID: 0, MAKER_ASK: 0 },
    exploreMinByKind: { TAKER_BUY: 0.1, TAKER_SELL: 0.1, MAKER_BID: 0.1, MAKER_ASK: 0.1 },
    exploreMaxByKind: { TAKER_BUY: 0.3, TAKER_SELL: 0.3, MAKER_BID: 0.3, MAKER_ASK: 0.3 },
    explicitHardBlocks: []
  }
});

describe("RegimeGate pair snapshot loading", () => {
  it("loads coherent manifest/file pair", () => {
    const fixture = buildFixture();
    try {
      writeSnapshot(fixture, "s1", 3.5);
      const gate = new RegimeGate(makeConfig(fixture), logger);
      const decision = gate.decide("TAKER_BUY", 1, { spread: 0.005 });
      expect(decision.allowed).toBe(true);
      expect(decision.wavgBps).toBeCloseTo(3.5);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps last-good pair when manifest stamp points to mismatched files", () => {
    const fixture = buildFixture();
    try {
      writeSnapshot(fixture, "s1", 3.5);
      const gate = new RegimeGate(makeConfig(fixture), logger);
      const before = gate.decide("TAKER_BUY", 1, { spread: 0.005 });
      expect(before.wavgBps).toBeCloseTo(3.5);

      const markovRaw = JSON.parse(readFileSync(fixture.markovPath, "utf-8"));
      markovRaw._meta.stamp = "s2";
      writeFileSync(fixture.markovPath, JSON.stringify(markovRaw, null, 2));
      writeFileSync(
        fixture.manifestPath,
        JSON.stringify(
          {
            stamp: "s2",
            generatedAt: new Date().toISOString(),
            markovFile: path.basename(fixture.markovPath),
            strategyFile: path.basename(fixture.strategyPath)
          },
          null,
          2
        )
      );

      (gate as any).load();
      const after = gate.decide("TAKER_BUY", 1, { spread: 0.005 });
      expect(after.wavgBps).toBeCloseTo(3.5);
      expect(after.reasonDetail).toContain("not_loaded_using_last_good");
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps last-good pair when one updated file is invalid", () => {
    const fixture = buildFixture();
    try {
      writeSnapshot(fixture, "s1", 4.2);
      const gate = new RegimeGate(makeConfig(fixture), logger);
      const before = gate.decide("TAKER_BUY", 1, { spread: 0.005 });
      expect(before.wavgBps).toBeCloseTo(4.2);

      const markovRaw = JSON.parse(readFileSync(fixture.markovPath, "utf-8"));
      markovRaw._meta.stamp = "s3";
      writeFileSync(fixture.markovPath, JSON.stringify(markovRaw, null, 2));
      writeFileSync(fixture.strategyPath, "{invalid-json");
      writeFileSync(
        fixture.manifestPath,
        JSON.stringify(
          {
            stamp: "s3",
            generatedAt: new Date().toISOString(),
            markovFile: path.basename(fixture.markovPath),
            strategyFile: path.basename(fixture.strategyPath)
          },
          null,
          2
        )
      );

      (gate as any).load();
      const after = gate.decide("TAKER_BUY", 1, { spread: 0.005 });
      expect(after.wavgBps).toBeCloseTo(4.2);
      expect(after.reasonDetail).toContain("not_loaded_using_last_good");
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps last-good when one file stamp changes without manifest update", () => {
    const fixture = buildFixture();
    try {
      writeSnapshot(fixture, "s1", 5.5);
      const gate = new RegimeGate(makeConfig(fixture), logger);
      const before = gate.decide("TAKER_BUY", 1, { spread: 0.005 });
      expect(before.wavgBps).toBeCloseTo(5.5);

      const markovRaw = JSON.parse(readFileSync(fixture.markovPath, "utf-8"));
      markovRaw._meta.stamp = "s2";
      writeFileSync(fixture.markovPath, JSON.stringify(markovRaw, null, 2));

      (gate as any).load();
      const after = gate.decide("TAKER_BUY", 1, { spread: 0.005 });
      expect(after.wavgBps).toBeCloseTo(5.5);
      expect(after.reasonDetail).toContain("not_loaded_using_last_good");
    } finally {
      fixture.cleanup();
    }
  });

  it("returns not_loaded_no_last_good when startup pair is incoherent", () => {
    const fixture = buildFixture();
    try {
      writeFileSync(
        fixture.markovPath,
        JSON.stringify(
          {
            _meta: { stamp: "a1" },
            config: { bins: 3, features: ["spread"] },
            edges: { spread: [0.01, 0.02] }
          },
          null,
          2
        )
      );
      writeFileSync(
        fixture.strategyPath,
        JSON.stringify(
          {
            _meta: { stamp: "b1" },
            rows: []
          },
          null,
          2
        )
      );
      writeFileSync(
        fixture.manifestPath,
        JSON.stringify(
          {
            stamp: "a1",
            generatedAt: new Date().toISOString(),
            markovFile: path.basename(fixture.markovPath),
            strategyFile: path.basename(fixture.strategyPath)
          },
          null,
          2
        )
      );

      const gate = new RegimeGate(makeConfig(fixture), logger);
      const decision = gate.decide("TAKER_BUY", 1, { spread: 0.005 });
      expect(decision.allowed).toBe(false);
      expect(decision.reasonCode).toBe("not_loaded_no_last_good");
    } finally {
      fixture.cleanup();
    }
  });
});
