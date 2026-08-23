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

