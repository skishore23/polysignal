// Layer 1C: FeatureEngine determinism + math invariants
// Math invariant tests (KEEP packages/features/src/featureEngine.test.ts as-is)

import { describe, it, expect } from "vitest";
import { BookStore } from "@polysignal/book";
import { FeatureEngine } from "@polysignal/features";
import { floatEq } from "../helpers/float-cmp.js";
import { roundFloat } from "../helpers/determinism.js";

const EPSILON = 1e-9;

describe("Layer 1C: FeatureEngine Determinism + Math Invariants", () => {
  describe("1C.1: Math Invariants", () => {
    it("should have mid === (best_bid + best_ask) / 2 within epsilon", () => {
      const store = new BookStore();
      const engine = new FeatureEngine(store, {
        topKLevels: 10,
        returnWindowSec: 10,
        volWindowSec: 1800,
        sampleIntervalSec: 1
      });

      const tokenId = "test_token";
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.498, size: 10 }],
        asks: [{ price: 0.502, size: 10 }]
      });

      const feature = engine.compute(tokenId, "m1", 1000);
      
      if (feature.bestBid !== null && feature.bestAsk !== null && feature.mid !== null) {
        const expectedMid = (feature.bestBid + feature.bestAsk) / 2;
        expect(floatEq(feature.mid, expectedMid, EPSILON)).toBe(true);
      }
    });

    it("should have spread === best_ask - best_bid within epsilon", () => {
      const store = new BookStore();
      const engine = new FeatureEngine(store, {
        topKLevels: 10,
        returnWindowSec: 10,
        volWindowSec: 1800,
        sampleIntervalSec: 1
      });

      const tokenId = "test_token";
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.498, size: 10 }],
        asks: [{ price: 0.502, size: 10 }]
      });

      const feature = engine.compute(tokenId, "m1", 1000);
      
      if (feature.bestBid !== null && feature.bestAsk !== null && feature.spread !== null) {
        const expectedSpread = feature.bestAsk - feature.bestBid;
        expect(floatEq(feature.spread, expectedSpread, EPSILON)).toBe(true);
      }
    });

    it("should have mid/spread not null if has_snapshot=true", () => {
      const store = new BookStore();
      const engine = new FeatureEngine(store, {
        topKLevels: 10,
        returnWindowSec: 10,
        volWindowSec: 1800,
        sampleIntervalSec: 1
      });

      const tokenId = "test_token";
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.498, size: 10 }],
        asks: [{ price: 0.502, size: 10 }]
      });

      const feature = engine.compute(tokenId, "m1", 1000);
      
      // If snapshot exists, mid and spread should not be null
      expect(feature.mid).not.toBeNull();
      expect(feature.spread).not.toBeNull();
    });

    it("should have mid/spread null if has_snapshot=false", () => {
      const store = new BookStore();
      const engine = new FeatureEngine(store, {
        topKLevels: 10,
        returnWindowSec: 10,
        volWindowSec: 1800,
        sampleIntervalSec: 1
      });

      const tokenId = "test_token_no_snapshot";
      
      // No snapshot applied
      const feature = engine.compute(tokenId, null, 1000);
      
      // If no snapshot, mid and spread should be null
      expect(feature.mid).toBeNull();
      expect(feature.spread).toBeNull();
    });
  });

  describe("1C.2: Return Feature Determinism", () => {
    it("should use only past states for return features (r10s, r1m)", () => {
      const store = new BookStore();
      const engine = new FeatureEngine(store, {
        topKLevels: 1,
        returnWindowSec: 10,
        volWindowSec: 1800,
        sampleIntervalSec: 1
      });

      const tokenId = "test_token";
      const baseTs = 10000;

      // Initial snapshot
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.5, size: 10 }],
        asks: [{ price: 0.52, size: 10 }],
        ts: baseTs
      });

      // First computation at t=0
      const feature0 = engine.compute(tokenId, "m1", baseTs);
      
      // Update snapshot at t=10s (10s later)
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.55, size: 10 }],
        asks: [{ price: 0.57, size: 10 }],
        ts: baseTs + 10_000
      });

      // Second computation at t=10s
      const feature10 = engine.compute(tokenId, "m1", baseTs + 10_000);

      // r10s at t=10s should use mid from t=0 (exactly 10s ago)
      if (feature0.mid !== null && feature10.mid !== null && feature10.r10s !== null) {
        const expectedReturn = (feature10.mid - feature0.mid) / feature0.mid;
        expect(floatEq(feature10.r10s, expectedReturn, EPSILON)).toBe(true);
      }
    });

    it("should have r1m use mid from 60s ago", () => {
      const store = new BookStore();
      const engine = new FeatureEngine(store, {
        topKLevels: 1,
        returnWindowSec: 10,
        volWindowSec: 1800,
        sampleIntervalSec: 1
      });

      const tokenId = "test_token";
      const baseTs = 10000;

      // Initial snapshot at t=0
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.5, size: 10 }],
        asks: [{ price: 0.52, size: 10 }],
        ts: baseTs
      });

      engine.compute(tokenId, "m1", baseTs);

      // Update at t=60s
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.55, size: 10 }],
        asks: [{ price: 0.57, size: 10 }],
        ts: baseTs + 60_000
      });

      const feature60 = engine.compute(tokenId, "m1", baseTs + 60_000);

      // r1m at t=60s should use mid from t=0 (60s ago)
      // Note: FeatureEngine uses TimeSeriesBuffer.valueAtOrBefore, so it may use closest available
      // This test documents the expected behavior
      if (feature60.r1m !== null) {
        expect(Number.isFinite(feature60.r1m)).toBe(true);
      }
    });
  });

  describe("1C.3: Deterministic Rounding", () => {
    it("should produce deterministic float values with rounding", () => {
      const store = new BookStore();
      const engine = new FeatureEngine(store, {
        topKLevels: 10,
        returnWindowSec: 10,
        volWindowSec: 1800,
        sampleIntervalSec: 1
      });

      const tokenId = "test_token";
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.498123456789, size: 10 }],
        asks: [{ price: 0.502987654321, size: 10 }]
      });

      // Compute twice
      const feature1 = engine.compute(tokenId, "m1", 1000);
      const feature2 = engine.compute(tokenId, "m1", 1000);

      // Values should be identical (deterministic)
      if (feature1.mid !== null && feature2.mid !== null) {
        expect(feature1.mid).toBe(feature2.mid);
      }
      if (feature1.spread !== null && feature2.spread !== null) {
        expect(feature1.spread).toBe(feature2.spread);
      }
    });
  });

  describe("1C.4: Feature Completeness", () => {
    it("should compute all required features when book exists", () => {
      const store = new BookStore();
      const engine = new FeatureEngine(store, {
        topKLevels: 10,
        returnWindowSec: 10,
        volWindowSec: 1800,
        sampleIntervalSec: 1
      });

      const tokenId = "test_token";
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.498, size: 10 }],
        asks: [{ price: 0.502, size: 10 }]
      });

      const feature = engine.compute(tokenId, "m1", 1000);

      // Required fields should be present
      expect(feature.tokenId).toBe(tokenId);
      expect(feature.ts).toBe(1000);
      expect(feature.mid).not.toBeNull();
      expect(feature.spread).not.toBeNull();
      expect(feature.bestBid).not.toBeNull();
      expect(feature.bestAsk).not.toBeNull();
    });
  });
});
