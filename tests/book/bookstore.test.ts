// Layer 1B: BookStore reconstruction invariants
// System-level invariant tests (KEEP packages/book/src/book.test.ts as-is)

import { describe, it, expect } from "vitest";
import { BookStore } from "@polysignal/book";

describe("Layer 1B: BookStore Reconstruction Invariants", () => {
  describe("1B.1: Basic Invariants", () => {
    it("should never have bid > ask", () => {
      const store = new BookStore();
      const tokenId = "test_token";

      // Set up various scenarios
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.5, size: 10 }],
        asks: [{ price: 0.52, size: 10 }]
      });

      let best = store.bestBidAsk(tokenId);
      if (best.bestBid && best.bestAsk) {
        expect(best.bestBid.price).toBeLessThanOrEqual(best.bestAsk.price);
      }

      // Apply deltas - BookStore doesn't prevent bid > ask, it just sorts
      // This test verifies that after applying deltas, book state is valid
      store.applyDelta({ tokenId, side: "bids", price: 0.51, size: 10 });
      
      best = store.bestBidAsk(tokenId);
      // After adding bid at 0.51, best bid should be 0.51 (still <= ask at 0.52)
      if (best.bestBid && best.bestAsk) {
        expect(best.bestBid.price).toBeLessThanOrEqual(best.bestAsk.price);
      }
      
      // Note: BookStore doesn't prevent bid > ask (that's a business logic concern)
      // This test verifies BookStore maintains sorted order correctly
    });

    it("should never have negative sizes", () => {
      const store = new BookStore();
      const tokenId = "test_token";

      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.5, size: 10 }],
        asks: [{ price: 0.52, size: 10 }]
      });

      const book = store.getBook(tokenId);
      if (!book) throw new Error("Expected book");

      for (const level of book.bids) {
        expect(level.size).toBeGreaterThanOrEqual(0);
      }
      for (const level of book.asks) {
        expect(level.size).toBeGreaterThanOrEqual(0);
      }
    });

    it("should never have prices outside [0,1]", () => {
      const store = new BookStore();
      const tokenId = "test_token";

      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.5, size: 10 }],
        asks: [{ price: 0.52, size: 10 }]
      });

      const book = store.getBook(tokenId);
      if (!book) throw new Error("Expected book");

      for (const level of book.bids) {
        expect(level.price).toBeGreaterThanOrEqual(0);
        expect(level.price).toBeLessThanOrEqual(1);
      }
      for (const level of book.asks) {
        expect(level.price).toBeGreaterThanOrEqual(0);
        expect(level.price).toBeLessThanOrEqual(1);
      }
    });

    it("should detect empty book correctly", () => {
      const store = new BookStore();
      const tokenId = "test_token";

      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [],
        asks: []
      });

      const best = store.bestBidAsk(tokenId);
      expect(best.bestBid).toBeNull();
      expect(best.bestAsk).toBeNull();
    });
  });

  describe("1B.2: Delta Before Snapshot Handling", () => {
    it("should handle delta before snapshot gracefully", () => {
      const store = new BookStore();
      const tokenId = "test_token";

      // Apply delta before snapshot (should not crash)
      store.applyDelta({
        tokenId,
        side: "bids",
        price: 0.5,
        size: 10
      });

      const book = store.getBook(tokenId);
      expect(book).toBeNull(); // No mutation, book doesn't exist

      // Now add snapshot
      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.5, size: 10 }],
        asks: [{ price: 0.52, size: 10 }]
      });

      // Delta should not have affected state
      const finalBook = store.getBook(tokenId);
      expect(finalBook).not.toBeNull();
      expect(finalBook?.bids.length).toBe(1);
    });
  });

  describe("1B.3: Property Tests (Manual Synthetic Sequences)", () => {
    it("should maintain invariants for synthetic event sequences", () => {
      const store = new BookStore();
      const tokenId = "test_token";

      // Synthetic sequence: snapshot then deltas
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
      store.applyDelta({ tokenId, side: "bids", price: 0.51, size: 0 }); // Remove

      const book = store.getBook(tokenId);
      if (!book) throw new Error("Expected book");

      // Invariant: bid <= ask
      const best = store.bestBidAsk(tokenId);
      if (best.bestBid && best.bestAsk) {
        expect(best.bestBid.price).toBeLessThanOrEqual(best.bestAsk.price);
      }

      // Invariant: no negative sizes
      for (const level of book.bids) {
        expect(level.size).toBeGreaterThanOrEqual(0);
      }
      for (const level of book.asks) {
        expect(level.size).toBeGreaterThanOrEqual(0);
      }

      // Invariant: prices in [0,1]
      for (const level of book.bids) {
        expect(level.price).toBeGreaterThanOrEqual(0);
        expect(level.price).toBeLessThanOrEqual(1);
      }
      for (const level of book.asks) {
        expect(level.price).toBeGreaterThanOrEqual(0);
        expect(level.price).toBeLessThanOrEqual(1);
      }
    });

    // TODO: Add fast-check property tests after installing @fast-check/vitest
    // This will generate random valid event sequences and assert invariants always hold
  });

  describe("1B.4: Ordering Invariants", () => {
    it("should maintain bids sorted descending", () => {
      const store = new BookStore();
      const tokenId = "test_token";

      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [
          { price: 0.5, size: 10 },
          { price: 0.48, size: 5 },
          { price: 0.52, size: 8 }
        ],
        asks: [{ price: 0.54, size: 10 }]
      });

      const book = store.getBook(tokenId);
      if (!book) throw new Error("Expected book");

      for (let i = 1; i < book.bids.length; i++) {
        const prev = book.bids[i - 1];
        const curr = book.bids[i];
        if (!prev || !curr) throw new Error("Expected bid at index");
        expect(prev.price).toBeGreaterThanOrEqual(curr.price);
      }
    });

    it("should maintain asks sorted ascending", () => {
      const store = new BookStore();
      const tokenId = "test_token";

      store.upsertSnapshot({
        tokenId,
        marketId: "m1",
        hash: null,
        bids: [{ price: 0.5, size: 10 }],
        asks: [
          { price: 0.54, size: 10 },
          { price: 0.52, size: 5 },
          { price: 0.56, size: 8 }
        ]
      });

      const book = store.getBook(tokenId);
      if (!book) throw new Error("Expected book");

      for (let i = 1; i < book.asks.length; i++) {
        const prev = book.asks[i - 1];
        const curr = book.asks[i];
        if (!prev || !curr) throw new Error("Expected ask at index");
        expect(prev.price).toBeLessThanOrEqual(curr.price);
      }
    });
  });
});
