import { readFile } from "node:fs/promises";
import { BookStore } from "@polysignal/book";
import { sleep, safeNumber } from "@polysignal/utils";

export type MockEvent = {
  t: number;
  type: "snapshot" | "delta";
  tokenId: string;
  marketId: string;
  bids?: [number, number][];
  asks?: [number, number][];
  side?: "BUY" | "SELL";
  price?: number;
  size?: number;
};

export async function loadMockEvents(path: string): Promise<MockEvent[]> {
  const raw = await readFile(path, "utf-8");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const events: MockEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as MockEvent;
      events.push(parsed);
    } catch {
      // skip
    }
  }
  return events.sort((a, b) => a.t - b.t);
}

export async function runMockFeed(args: {
  events: MockEvent[];
  store: BookStore;
  speed: number;
  baseTs?: number;
  onEvent?: (ev: MockEvent) => void;
}): Promise<void> {
  let prev = 0;
  const base = args.baseTs ?? Date.now();
  for (const ev of args.events) {
    const delay = Math.max(0, (ev.t - prev) / Math.max(1, args.speed));
    if (delay > 0) await sleep(delay);
    prev = ev.t;

    if (ev.type === "snapshot") {
      args.store.upsertSnapshot({
        tokenId: ev.tokenId,
        marketId: ev.marketId,
        hash: null,
        bids: (ev.bids ?? []).map((x) => ({
          price: safeNumber(x[0]) ?? 0,
          size: safeNumber(x[1]) ?? 0
        })),
        asks: (ev.asks ?? []).map((x) => ({
          price: safeNumber(x[0]) ?? 0,
          size: safeNumber(x[1]) ?? 0
        })),
        ts: base + ev.t
      });
    }

    if (ev.type === "delta" && ev.side && ev.price != null && ev.size != null) {
      args.store.applyDelta({
        tokenId: ev.tokenId,
        side: ev.side === "BUY" ? "bids" : "asks",
        price: ev.price,
        size: ev.size,
        ts: base + ev.t
      });
    }

    args.onEvent?.(ev);
  }
}
