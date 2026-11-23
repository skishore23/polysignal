import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { ClobWsClient } from "../../packages/data/src/clobWs.js";

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  public readonly sent: string[] = [];
  public readonly url: string;
  public readyState = MockWebSocket.OPEN;

  constructor(url: string) {
    super();
    this.url = url;
  }

  send(payload: string, cb?: (err?: Error) => void): void {
    this.sent.push(payload);
    cb?.();
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }
}

describe("ClobWsClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const harness = () => {
    const sockets: MockWebSocket[] = [];
    const handlers = { onBook: vi.fn(), onPriceChange: vi.fn(), onTrade: vi.fn() };
    const client = new ClobWsClient({
      url: "wss://example.test/ws/market",
      assetIds: ["token-1", "token-2"],
      handlers,
      webSocketFactory: (url) => {
        const ws = new MockWebSocket(url);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      }
    });
    client.connect();
    const ws = sockets[0]!;
    ws.emit("open");
    return { client, sockets, ws, ...handlers };
  };

  // Documented raw API shapes, not recorded venue executions:
  // https://docs.polymarket.com/market-data/realtime-data (Market Stream / API).
  it("rejects coerced nonnumeric prices and sizes while preserving explicit zero book sizes", () => {
    const { client, ws, onTrade, onBook, onPriceChange } = harness();
    try {
      for (const bad of [null, true, false, "", " ", [], [1], {}]) {
        for (const field of ["price", "size"]) {
          const level = { price: "0.08", size: "2", [field]: bad };
          ws.emit("message", JSON.stringify({
            event_type: "last_trade_price", asset_id: "token-1", side: "BUY", ...level
          }));
          ws.emit("message", JSON.stringify({
            event_type: "book", asset_id: "token-1", bids: [level], asks: []
          }));
          ws.emit("message", JSON.stringify({
            event_type: "book", asset_id: "token-1", bids: [[level.price, level.size]], asks: []
          }));
          ws.emit("message", JSON.stringify({
            event_type: "price_change", asset_id: "token-1", price_changes: [{ ...level, side: "BUY" }]
          }));
          ws.emit("message", JSON.stringify({
            event_type: "price_change_v2", asset_id: "token-1", changes: [[level.price, level.size, "BUY"]]
          }));
        }
      }
      expect(onTrade).not.toHaveBeenCalled();
      expect(onBook).not.toHaveBeenCalled();
      expect(onPriceChange).not.toHaveBeenCalled();
      ws.emit("message", JSON.stringify({
        event_type: "price_change", asset_id: "token-1", price_changes: [
          { price: "0.08", size: "0", side: "BUY" },
          { price: 0.09, size: 0, side: "SELL" }
        ]
      }));
      expect(onPriceChange).toHaveBeenCalledTimes(1);
      expect(onPriceChange).toHaveBeenCalledWith("token-1", [
        { price: 0.08, size: 0, side: "BUY", hash: null },
        { price: 0.09, size: 0, side: "SELL", hash: null }
      ], expect.any(Number));
      ws.emit("message", JSON.stringify({
        event_type: "last_trade_price", asset_id: "token-1", price: "0.08", size: "2", side: "BUY"
      }));
      expect(onTrade).toHaveBeenCalledTimes(1);
      expect(onTrade).toHaveBeenCalledWith(expect.objectContaining({ price: 0.08, size: 2 }));
    } finally { client.close(); }
  });

  it("ignores non-event JSON without throwing and still processes the next valid trade", () => {
    const { client, ws, onTrade, onBook, onPriceChange } = harness();
    try {
      for (const frame of ["null", "false", "42", '"text"', "[]", "[null]"]) {
        expect(() => ws.emit("message", frame)).not.toThrow();
      }
      expect(onTrade).not.toHaveBeenCalled();
      expect(onBook).not.toHaveBeenCalled();
      expect(onPriceChange).not.toHaveBeenCalled();
      ws.emit("message", JSON.stringify({
        event_type: "last_trade_price", asset_id: "token-1",
        price: "0.08", size: "1", side: "BUY", timestamp: "1782753357257"
      }));
      expect(onTrade).toHaveBeenCalledTimes(1);
      expect(onTrade).toHaveBeenCalledWith(expect.objectContaining({
        tokenId: "token-1", price: 0.08, size: 1, timestamp: 1782753357257
      }));
    } finally { client.close(); }
  });

  it("preserves the documented millisecond string timestamp", () => {
    const { client, ws, onTrade } = harness();
    try {
      ws.emit("message", JSON.stringify({
        event_type: "last_trade_price", asset_id: "token-1", market: "market-1",
        price: "0.08", size: "219.217767", side: "SELL", timestamp: "1782753357257"
      }));
      expect(onTrade).toHaveBeenCalledWith(expect.objectContaining({ timestamp: 1782753357257 }));
    } finally { client.close(); }
  });

  it.each(["", " ", "not-a-time", "2026-06-29T17:15:57Z", "Infinity", "9007199254740993"])(
    "keeps unsupported timestamp %j unknown", (timestamp) => {
      const { client, ws, onTrade } = harness();
      try {
        ws.emit("message", JSON.stringify({
          event_type: "last_trade_price", asset_id: "token-1", price: "0.08",
          size: "1", side: "BUY", timestamp
        }));
        expect(onTrade).toHaveBeenCalledWith(expect.objectContaining({ timestamp: null }));
      } finally { client.close(); }
    }
  );

  it("dispatches documented price changes by each nested asset without a top-level asset", () => {
    const { client, ws, onPriceChange } = harness();
    try {
      ws.emit("message", JSON.stringify({
        event_type: "price_change", market: "market-1", timestamp: "1782753357257",
        price_changes: [
          { asset_id: "token-1", price: "0.08", size: "3", side: "BUY", hash: "h1" },
          { asset_id: "token-2", price: "0.92", size: "4", side: "SELL", hash: "h2" },
          { asset_id: "token-1", price: "0.07", size: "5", side: "BUY", hash: "h3" }
        ]
      }));
      expect(onPriceChange.mock.calls.map(([id, changes]) => [id, changes])).toEqual([
        ["token-1", [{ price: 0.08, size: 3, side: "BUY", hash: "h1" },
          { price: 0.07, size: 5, side: "BUY", hash: "h3" }]],
        ["token-2", [{ price: 0.92, size: 4, side: "SELL", hash: "h2" }]]
      ]);
    } finally { client.close(); }
  });

  it("retains legacy top-level change routing without guessing unknown sides or assets", () => {
    const { client, ws, onPriceChange } = harness();
    try {
      ws.emit("message", JSON.stringify({
        event_type: "price_change_v2", asset_id: "token-1",
        changes: [["0.1", "3", "BUY"], ["0.2", "4", "UNKNOWN"]]
      }));
      ws.emit("message", JSON.stringify({
        event_type: "price_change", price_changes: [
          { price: "0.3", size: "2", side: "BUY" },
          { asset_id: "token-2", price: "0.4", size: "2", side: "UNKNOWN" }
        ]
      }));
      expect(onPriceChange).toHaveBeenCalledTimes(1);
      expect(onPriceChange).toHaveBeenCalledWith("token-1", [{ price: 0.1, size: 3, side: "BUY" }], expect.any(Number));
    } finally { client.close(); }
  });

  it("sends one heartbeat per live connection and clears heartbeat/reconnect work on close", () => {
    vi.useFakeTimers();
    const { client, ws, sockets } = harness();
    vi.advanceTimersByTime(10000);
    expect(ws.sent.filter((s) => s === "PING")).toHaveLength(1);
    ws.emit("message", "PONG");
    ws.close();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    const replacement = sockets[1]!;
    replacement.emit("open");
    vi.advanceTimersByTime(10000);
    expect(ws.sent.filter((s) => s === "PING")).toHaveLength(1);
    expect(replacement.sent.filter((s) => s === "PING")).toHaveLength(1);
    replacement.close();
    client.close();
    vi.advanceTimersByTime(30000);
    expect(sockets).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("subscribes to market channel and emits last_trade_price as trades", () => {
    const sockets: MockWebSocket[] = [];
    const onTrade = vi.fn();
    const onBook = vi.fn();
    const onPriceChange = vi.fn();

    const client = new ClobWsClient({
      url: "wss://example.test/ws/market",
      assetIds: ["token-1", "token-2"],
      handlers: { onBook, onPriceChange, onTrade },
      webSocketFactory: (url: string) => {
        const ws = new MockWebSocket(url);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      }
    });

    client.connect();
    expect(sockets).toHaveLength(1);
    const ws = sockets[0];
    expect(ws).toBeDefined();

    ws?.emit("open");
    expect(ws?.sent).toHaveLength(1);
    expect(JSON.parse(ws?.sent[0] ?? "{}")).toEqual({
      type: "market",
      assets_ids: ["token-1", "token-2"]
    });

    ws?.emit(
      "message",
      JSON.stringify({
        event_type: "last_trade_price",
        asset_id: "token-1",
        market: "market-1",
        price: "0.58",
        side: "BUY",
        size: "13.5",
        timestamp: 1_770_000_000
      })
    );

    expect(onTrade).toHaveBeenCalledTimes(1);
    expect(onTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: "token-1",
        marketId: "market-1",
        price: 0.58,
        size: 13.5,
        side: "BUY",
        timestamp: 1_770_000_000_000
      })
    );

    client.close();
  });
});

