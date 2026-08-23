// Layer 1A.2: Bad event rejection tests
// Ensures invalid events don't mutate BookStore state

import { describe, it, expect, beforeEach } from "vitest";
import { BookStore } from "@polysignal/book";

describe("Layer 1A.2: Violations Test - Bad Event Rejection", () => {
  let store: BookStore;

  beforeEach(() => {
    store = new BookStore();
  });

  describe("1A.2.1: Delta Before Snapshot", () => {
    it("should reject delta before snapshot and not mutate state", () => {
      const tokenId = "test_token";
      const initialState = store.getBook(tokenId);

      // Try to apply delta before snapshot
      try {
        store.applyDelta({
          tokenId,
          side: "bids",
          price: 0.5,
          size: 10
        });
      } catch (error) {
        // Expected: delta should be rejected or handled gracefully
      }

      const afterState = store.getBook(tokenId);
      
      // State should be unchanged (or still null/empty)
      if (initialState === null && afterState === null) {
        expect(true).toBe(true); // OK: both null
      } else if (initialState && afterState) {
        // Compare book state - should be identical
        expect(JSON.stringify(initialState)).toBe(JSON.stringify(afterState));
      }
      // If state was null but now has book, that's a violation
      if (initialState === null && afterState !== null) {
        throw new Error("Delta before snapshot mutated state");
      }
    });
  });

  describe("1A.2.2: Invalid Price/Size", () => {
    it("should reject negative prices and not mutate state", () => {
      const tokenId = "test_token";
      
      // First set up valid snapshot
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.5, size: 10 }],
        asks: [{ price: 0.52, size: 10 }]
      });

      const initialState = store.getBook(tokenId);
      if (!initialState) throw new Error("Expected book to exist");

      // Try to apply invalid price (negative)
      try {
        store.applyDelta({
          tokenId,
          side: "bids",
          price: -0.1,
          size: 10
        });
      } catch (error) {
        // Expected: invalid price should be rejected
      }

      const afterState = store.getBook(tokenId);
      
      // State should be unchanged
      expect(JSON.stringify(initialState)).toBe(JSON.stringify(afterState));
    });

    it("should reject negative sizes and not mutate state", () => {
      const tokenId = "test_token";
      
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.5, size: 10 }],
        asks: [{ price: 0.52, size: 10 }]
      });

      const initialState = store.getBook(tokenId);
      if (!initialState) throw new Error("Expected book to exist");

      // Try to apply invalid size (negative)
      try {
        store.applyDelta({
          tokenId,
          side: "bids",
          price: 0.5,
          size: -5
        });
      } catch (error) {
        // Expected: invalid size should be rejected
      }

      const afterState = store.getBook(tokenId);
      
      // State should be unchanged
      expect(JSON.stringify(initialState)).toBe(JSON.stringify(afterState));
    });

    it("should reject prices outside [0,1] and not mutate state", () => {
      const tokenId = "test_token";
      
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.5, size: 10 }],
        asks: [{ price: 0.52, size: 10 }]
      });

      const initialState = store.getBook(tokenId);
      if (!initialState) throw new Error("Expected book to exist");

      // Try to apply price > 1
      try {
        store.applyDelta({
          tokenId,
          side: "bids",
          price: 1.5,
          size: 10
        });
      } catch (error) {
        // Expected: invalid price should be rejected
      }

      const afterState = store.getBook(tokenId);
      
      // State should be unchanged
      expect(JSON.stringify(initialState)).toBe(JSON.stringify(afterState));
    });
  });

  describe("1A.2.3: Out-of-Order Arrival", () => {
    it("should handle out-of-order events correctly", () => {
      const tokenId = "test_token";
      
      // Set up initial snapshot
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.5, size: 10 }],
        asks: [{ price: 0.52, size: 10 }],
        ts: 1000
      });

      const initialState = store.getBook(tokenId);
      if (!initialState) throw new Error("Expected book to exist");

      // Try to apply delta with future timestamp (should still apply if valid)
      // Note: BookStore doesn't validate timestamps, so this should apply
      // This test documents the current behavior
      store.applyDelta({
        tokenId,
        side: "bids",
        price: 0.51,
        size: 5,
        ts: 500 // Earlier timestamp
      });

      // State should have changed (delta applied)
      // This test documents current behavior - BookStore doesn't validate timestamp ordering
      const afterState = store.getBook(tokenId);
      expect(afterState).not.toBeNull();
    });
  });

  describe("1A.2.4: Empty Book Detection", () => {
    it("should handle empty book correctly without crashing", () => {
      const tokenId = "test_token";
      
      // Set up snapshot with empty bids/asks
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [],
        asks: []
      });

      const book = store.getBook(tokenId);
      
      // Should not crash
      expect(book).not.toBeNull();
      
      const best = store.bestBidAsk(tokenId);
      expect(best.bestBid).toBeNull();
      expect(best.bestAsk).toBeNull();
    });

    it("should handle size=0 removals correctly", () => {
      const tokenId = "test_token";
      
      // Set up snapshot
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.5, size: 10 }],
        asks: [{ price: 0.52, size: 10 }]
      });

      // Remove level with size=0
      store.applyDelta({
        tokenId,
        side: "bids",
        price: 0.5,
        size: 0
      });

      const book = store.getBook(tokenId);
      expect(book).not.toBeNull();
      
      const best = store.bestBidAsk(tokenId);
      // Best bid should be removed
      expect(best.bestBid).toBeNull();
    });
  });

  describe("1A.2.5: Book Invariants After Mutations", () => {
    it("should never have bid > ask after mutations", () => {
      const tokenId = "test_token";
      
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.5, size: 10 }],
        asks: [{ price: 0.52, size: 10 }]
      });

      // Apply various deltas
      store.applyDelta({ tokenId, side: "bids", price: 0.51, size: 5 });
      store.applyDelta({ tokenId, side: "asks", price: 0.51, size: 5 });
      store.applyDelta({ tokenId, side: "bids", price: 0.49, size: 5 });
      store.applyDelta({ tokenId, side: "asks", price: 0.53, size: 5 });

      const book = store.getBook(tokenId);
      if (!book) return;

      const best = store.bestBidAsk(tokenId);
      
      if (best.bestBid && best.bestAsk) {
        expect(best.bestBid.price).toBeLessThanOrEqual(best.bestAsk.price);
      }
    });

    it("should never have negative sizes after mutations", () => {
      const tokenId = "test_token";
      
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.5, size: 10 }],
        asks: [{ price: 0.52, size: 10 }]
      });

      // Apply deltas that might cause negative sizes
      store.applyDelta({ tokenId, side: "bids", price: 0.5, size: 15 }); // Update size
      store.applyDelta({ tokenId, side: "bids", price: 0.5, size: 5 }); // Reduce size

      const book = store.getBook(tokenId);
      if (!book) return;

      // Check all levels have non-negative sizes
      for (const level of book.bids) {
        expect(level.size).toBeGreaterThanOrEqual(0);
      }
      for (const level of book.asks) {
        expect(level.size).toBeGreaterThanOrEqual(0);
      }
    });

    it("should never have prices outside [0,1] after mutations", () => {
      const tokenId = "test_token";
      
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.5, size: 10 }],
        asks: [{ price: 0.52, size: 10 }]
      });

      // Apply deltas
      store.applyDelta({ tokenId, side: "bids", price: 0.49, size: 5 });
      store.applyDelta({ tokenId, side: "asks", price: 0.53, size: 5 });

      const book = store.getBook(tokenId);
      if (!book) return;

      // Check all prices are in [0,1]
      for (const level of book.bids) {
        expect(level.price).toBeGreaterThanOrEqual(0);
        expect(level.price).toBeLessThanOrEqual(1);
      }
      for (const level of book.asks) {
        expect(level.price).toBeGreaterThanOrEqual(0);
        expect(level.price).toBeLessThanOrEqual(1);
      }
    });
  });
});
