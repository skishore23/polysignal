import { describe, expect, it } from "vitest";
import { BookStore } from "@polysignal/book";
import { FeatureEngine } from "./featureEngine";

describe("FeatureEngine", () => {
  it("computes OBI and microprice", () => {
    const store = new BookStore();
    store.upsertSnapshot({
      tokenId: "t1",
      marketId: "m1",
      hash: null,
      bids: [
        { price: 0.5, size: 10 },
        { price: 0.49, size: 5 }
      ],
      asks: [
        { price: 0.52, size: 8 },
        { price: 0.53, size: 4 }
      ],
      ts: 1000
    });

    const engine = new FeatureEngine(store, {
      topKLevels: 2,
      returnWindowSec: 10,
      volWindowSec: 1800,
      sampleIntervalSec: 1
    });

    const feature = engine.compute("t1", "m1", 1000);
    expect(feature.obi).toBeCloseTo((15 - 12) / (15 + 12));
    expect(feature.microprice).toBeCloseTo((0.52 * 10 + 0.5 * 8) / 18);
  });

  it("computes returns over windows", () => {
    const store = new BookStore();
    store.upsertSnapshot({
      tokenId: "t1",
      marketId: "m1",
      hash: null,
      bids: [{ price: 0.5, size: 10 }],
      asks: [{ price: 0.52, size: 10 }],
      ts: 0
    });

    const engine = new FeatureEngine(store, {
      topKLevels: 1,
      returnWindowSec: 10,
      volWindowSec: 1800,
      sampleIntervalSec: 1
    });

    engine.compute("t1", "m1", 0);

    store.upsertSnapshot({
      tokenId: "t1",
      marketId: "m1",
      hash: null,
      bids: [{ price: 0.55, size: 10 }],
      asks: [{ price: 0.57, size: 10 }],
      ts: 10_000
    });

    const feature = engine.compute("t1", "m1", 10_000);
    expect(feature.r10s).toBeCloseTo((0.56 - 0.51) / 0.51, 3);
  });

  it("computes acceleration of returns", () => {
    const store = new BookStore();
    store.upsertSnapshot({
      tokenId: "t1",
      marketId: "m1",
      hash: null,
      bids: [{ price: 0.5, size: 10 }],
      asks: [{ price: 0.52, size: 10 }],
      ts: 0
    });

    const engine = new FeatureEngine(store, {
      topKLevels: 1,
      returnWindowSec: 10,
      volWindowSec: 1800,
      sampleIntervalSec: 1
    });

    engine.compute("t1", "m1", 0);

    store.upsertSnapshot({
      tokenId: "t1",
      marketId: "m1",
      hash: null,
      bids: [{ price: 0.55, size: 10 }],
      asks: [{ price: 0.57, size: 10 }],
      ts: 10_000
    });

    engine.compute("t1", "m1", 10_000);

    store.upsertSnapshot({
      tokenId: "t1",
      marketId: "m1",
      hash: null,
      bids: [{ price: 0.59, size: 10 }],
      asks: [{ price: 0.61, size: 10 }],
      ts: 70_000
    });

    const feature = engine.compute("t1", "m1", 70_000);
    // accel1m needs 120s of mid history (change in 1m return); this scenario only has 0s, 10s, 70s
    expect(feature.accel1m).toBeNull();
  });

  it("computes accel1m when 120s of mid history exists", () => {
    const store = new BookStore();
    const engine = new FeatureEngine(store, {
      topKLevels: 1,
      returnWindowSec: 10,
      volWindowSec: 1800,
      sampleIntervalSec: 1
    });
    // ts 0 -> mid 0.50, 60s -> 0.51, 120s -> 0.56: r1m_now = (0.56-0.51)/0.51, r1m_prev = (0.51-0.50)/0.50, accel = r1m_now - r1m_prev
    for (const { ts, mid } of [
      { ts: 0, mid: 0.5 },
      { ts: 60_000, mid: 0.51 },
      { ts: 120_000, mid: 0.56 }
    ]) {
      store.upsertSnapshot({
        tokenId: "t1",
        marketId: "m1",
        hash: null,
        bids: [{ price: mid - 0.01, size: 10 }],
        asks: [{ price: mid + 0.01, size: 10 }],
        ts
      });
      engine.compute("t1", "m1", ts);
    }
    const feature = engine.compute("t1", "m1", 120_000);
    expect(feature.accel1m).not.toBeNull();
    const r1mNow = (0.56 - 0.51) / 0.51;
    const r1mPrev = (0.51 - 0.5) / 0.5;
    expect(feature.accel1m).toBeCloseTo(r1mNow - r1mPrev, 10);
  });

  it("computes skewness and entropy of returns", () => {
    const store = new BookStore();
    const engine = new FeatureEngine(store, {
      topKLevels: 1,
      returnWindowSec: 10,
      volWindowSec: 60,
      sampleIntervalSec: 1
    });

    // Mids must be in [0,1] (BookStore sanitizes levels). Need >=4 return points within volWindowSec.
    const samples = [
      { ts: 0, mid: 0.50 },
      { ts: 10_000, mid: 0.51 },
      { ts: 20_000, mid: 0.49 },
      { ts: 30_000, mid: 0.54 },
      { ts: 40_000, mid: 0.52 },
      { ts: 50_000, mid: 0.56 },
      { ts: 60_000, mid: 0.53 },
      { ts: 70_000, mid: 0.58 }
    ];

    let feature = engine.compute("t1", "m1", 0);
    for (const sample of samples) {
      store.upsertSnapshot({
        tokenId: "t1",
        marketId: "m1",
        hash: null,
        bids: [{ price: sample.mid - 0.01, size: 10 }],
        asks: [{ price: sample.mid + 0.01, size: 10 }],
        ts: sample.ts
      });
      feature = engine.compute("t1", "m1", sample.ts);
    }
    expect(feature.skew30m).not.toBeNull();
    expect(feature.entropy30m).not.toBeNull();
    expect(typeof (feature.skew30m as number)).toBe("number");
    expect(feature.entropy30m as number).toBeGreaterThan(0);
    expect(feature.entropy30m as number).toBeLessThanOrEqual(1);
  });
});
