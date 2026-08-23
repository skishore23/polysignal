import { describe, expect, it } from "vitest";
import { BookStore } from "./index";

describe("BookStore", () => {
  it("applies snapshot and keeps order", () => {
    const store = new BookStore();
    store.upsertSnapshot({
      tokenId: "t1",
      marketId: "m1",
      hash: null,
      bids: [
        { price: 0.48, size: 5 },
        { price: 0.5, size: 10 }
      ],
      asks: [
        { price: 0.52, size: 7 },
        { price: 0.51, size: 12 }
      ]
    });

    const book = store.getBook("t1");
    expect(book).not.toBeNull();
    expect(book?.bids[0]?.price).toBe(0.5);
    expect(book?.asks[0]?.price).toBe(0.51);
  });

  it("applies deltas and removes levels", () => {
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
        { price: 0.51, size: 8 }
      ]
    });

    store.applyDelta({ tokenId: "t1", side: "bids", price: 0.5, size: 0 });
    store.applyDelta({ tokenId: "t1", side: "asks", price: 0.52, size: 4 });

    const book = store.getBook("t1");
    expect(book).not.toBeNull();
    expect(book?.bids[0]?.price).toBe(0.49);
    expect(book?.asks[0]?.price).toBe(0.51);
    expect(book?.asks[1]?.price).toBe(0.52);
  });

  it("returns best bid/ask", () => {
    const store = new BookStore();
    store.upsertSnapshot({
      tokenId: "t1",
      marketId: "m1",
      hash: null,
      bids: [{ price: 0.6, size: 1 }],
      asks: [{ price: 0.7, size: 1 }]
    });

    const best = store.bestBidAsk("t1");
    expect(best.bestBid?.price).toBe(0.6);
    expect(best.bestAsk?.price).toBe(0.7);
  });
});
