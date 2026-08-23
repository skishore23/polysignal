import { nowMs } from "@polysignal/utils";

export type Level = { price: number; size: number };
export type Book = {
  tokenId: string;
  marketId: string | null;
  hash: string | null;
  bids: Level[];
  asks: Level[];
  // Last time the book itself changed (snapshot/delta).
  lastUpdatedMs: number;
  // Last time we received any related event (trade/heartbeat), even if book didn't change.
  lastEventMs: number;
  lastEventGlobalSeq: number | null;
  recvTsMs: number | null;
};

export type BookSide = "bids" | "asks";

export class BookStore {
  private books = new Map<string, Book>();

  getBook(tokenId: string): Book | null {
    return this.books.get(tokenId) ?? null;
  }

  upsertSnapshot(args: {
    tokenId: string;
    marketId: string | null;
    hash: string | null;
    bids: Level[];
    asks: Level[];
    ts?: number;
    lastEventGlobalSeq?: number | null;
    recvTsMs?: number | null;
  }): void {
    const ts = args.ts ?? nowMs();
    const eventTs = args.recvTsMs ?? ts;
    const bids = sanitizeLevels(args.bids, true);
    const asks = sanitizeLevels(args.asks, false);

    this.books.set(args.tokenId, {
      tokenId: args.tokenId,
      marketId: args.marketId,
      hash: args.hash,
      bids,
      asks,
      lastUpdatedMs: ts,
      lastEventMs: eventTs,
      lastEventGlobalSeq: args.lastEventGlobalSeq ?? null,
      recvTsMs: args.recvTsMs ?? null
    });
  }

  applyDelta(args: {
    tokenId: string;
    side: BookSide;
    price: number;
    size: number;
    hash?: string | null;
    ts?: number;
    lastEventGlobalSeq?: number | null;
    recvTsMs?: number | null;
  }): void {
    const book = this.books.get(args.tokenId);
    if (!book) return;
    if (!isValidPrice(args.price) || !Number.isFinite(args.size) || args.size < 0) return;
    const ts = args.ts ?? nowMs();
    const eventTs = args.recvTsMs ?? ts;
    const levels = args.side === "bids" ? book.bids : book.asks;
    upsertLevel(levels, args.price, args.size, args.side === "bids");
    book.hash = args.hash ?? book.hash;
    book.lastUpdatedMs = ts;
    book.lastEventMs = eventTs;
    if (args.lastEventGlobalSeq != null) {
      book.lastEventGlobalSeq = args.lastEventGlobalSeq;
    }
    if (args.recvTsMs != null) {
      book.recvTsMs = args.recvTsMs;
    }
  }

  touch(tokenId: string, ts?: number): void {
    const book = this.books.get(tokenId);
    if (book) book.lastEventMs = ts ?? nowMs();
  }

  bestBidAsk(tokenId: string): { bestBid: Level | null; bestAsk: Level | null } {
    const book = this.books.get(tokenId);
    if (!book) return { bestBid: null, bestAsk: null };
    return {
      bestBid: book.bids[0] ?? null,
      bestAsk: book.asks[0] ?? null
    };
  }

  topLevels(tokenId: string, k: number): { bids: Level[]; asks: Level[] } {
    const book = this.books.get(tokenId);
    if (!book) return { bids: [], asks: [] };
    return {
      bids: book.bids.slice(0, k),
      asks: book.asks.slice(0, k)
    };
  }

  /**
   * Returns an immutable snapshot of the book with best bid/ask.
   * Use this for atomic exit price computation to avoid stale quote issues.
   * All fields come from the same internal book object (truly atomic).
   */
  getBookSnapshot(tokenId: string): {
    bestBid: number | null;
    bestAsk: number | null;
    lastUpdatedMs: number;
    lastEventGlobalSeq: number | null;
    recvTsMs: number | null;
  } | null {
    const book = this.books.get(tokenId);
    if (!book) return null;
    
    // Return immutable snapshot (copy of top level) - all from same internal object
    return {
      bestBid: book.bids[0]?.price ?? null,
      bestAsk: book.asks[0]?.price ?? null,
      lastUpdatedMs: book.lastUpdatedMs,
      lastEventGlobalSeq: book.lastEventGlobalSeq ?? null,
      recvTsMs: book.recvTsMs ?? null
    };
  }
}

function isValidPrice(price: number): boolean {
  return Number.isFinite(price) && price >= 0 && price <= 1;
}

function isValidSize(size: number): boolean {
  return Number.isFinite(size) && size > 0;
}

function sanitizeLevels(levels: Level[], isBids: boolean): Level[] {
  const sanitized = levels
    .map((x) => ({ price: x.price, size: x.size }))
    .filter((x) => isValidPrice(x.price) && isValidSize(x.size));
  sanitized.sort((a, b) => (isBids ? b.price - a.price : a.price - b.price));
  return sanitized;
}

function upsertLevel(levels: Level[], price: number, size: number, isBids: boolean): void {
  const idx = levels.findIndex((l) => l.price === price);
  if (size <= 0) {
    if (idx >= 0) levels.splice(idx, 1);
  } else if (idx >= 0) {
    levels[idx] = { price, size };
  } else {
    levels.push({ price, size });
  }
  levels.sort((a, b) => (isBids ? b.price - a.price : a.price - b.price));
}
