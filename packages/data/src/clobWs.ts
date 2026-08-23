import WebSocket from "ws";
import type { LoggerLike } from "@polysignal/utils";

export type ClobWsLevel = { price: number; size: number };
export type ClobWsPriceChange = { price: number; size: number; side: "BUY" | "SELL"; hash?: string | null };
export type ClobWsTrade = {
  tokenId: string;
  marketId: string | null;
  price: number;
  size: number;
  side: "BUY" | "SELL";
  timestamp: number | null;
  recvTsMs: number;
};

export type ClobWsBook = {
  tokenId: string;
  marketId: string | null;
  hash: string | null;
  bids: ClobWsLevel[];
  asks: ClobWsLevel[];
  recvTsMs: number;
};

export type ClobWsHandlers = {
  onBook: (book: ClobWsBook) => void;
  onPriceChange: (tokenId: string, changes: ClobWsPriceChange[], recvTsMs: number) => void;
  onTrade?: (trade: ClobWsTrade) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (err: unknown) => void;
  log?: LoggerLike;
};

export type ClobWsClientArgs = {
  url: string;
  assetIds: string[];
  handlers: ClobWsHandlers;
  webSocketFactory?: (url: string) => WebSocket;
};

const parseLevels = (raw: unknown): ClobWsLevel[] => {
  if (!Array.isArray(raw)) return [];
  const levels: ClobWsLevel[] = [];
  for (const item of raw) {
    if (Array.isArray(item) && item.length >= 2) {
      const price = Number(item[0]);
      const size = Number(item[1]);
      if (Number.isFinite(price) && Number.isFinite(size)) {
        levels.push({ price, size });
      }
      continue;
    }
    if (typeof item === "object" && item !== null) {
      const price = Number((item as { price?: unknown }).price);
      const size = Number((item as { size?: unknown }).size);
      if (Number.isFinite(price) && Number.isFinite(size)) {
        levels.push({ price, size });
      }
    }
  }
  return levels;
};

const parseChanges = (raw: unknown): ClobWsPriceChange[] => {
  if (!Array.isArray(raw)) return [];
  const changes: ClobWsPriceChange[] = [];
  for (const item of raw) {
    if (Array.isArray(item) && item.length >= 3) {
      const price = Number(item[0]);
      const size = Number(item[1]);
      const side = String(item[2]) === "SELL" ? "SELL" : "BUY";
      if (Number.isFinite(price) && Number.isFinite(size)) {
        changes.push({ price, size, side });
      }
      continue;
    }
    if (typeof item === "object" && item !== null) {
      const price = Number((item as { price?: unknown }).price);
      const size = Number((item as { size?: unknown }).size);
      const side = String((item as { side?: unknown }).side) === "SELL" ? "SELL" : "BUY";
      const hash = (item as { hash?: string | null }).hash ?? null;
      if (Number.isFinite(price) && Number.isFinite(size)) {
        changes.push({ price, size, side, hash });
      }
    }
  }
  return changes;
};

export class ClobWsClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private readonly url: string;
  private readonly assetIds: string[];
  private readonly handlers: ClobWsHandlers;
  private readonly wsFactory: (url: string) => WebSocket;
  private reconnectDelayMs = 1000;

  constructor(args: ClobWsClientArgs) {
    this.url = args.url;
    this.assetIds = args.assetIds;
    this.handlers = args.handlers;
    this.wsFactory = args.webSocketFactory ?? ((url: string) => new WebSocket(url));
  }

  connect(): void {
    if (this.closed) return;
    const { log } = this.handlers;
    log?.info({ assetCount: this.assetIds.length }, "CLOB WS connecting");
    this.ws = this.wsFactory(this.url);

    this.ws.on("open", () => {
      this.reconnectDelayMs = 1000;
      const payload = {
        type: "market",
        assets_ids: this.assetIds
      };
      this.ws?.send(JSON.stringify(payload));
      log?.info({ assetCount: this.assetIds.length }, "CLOB WS subscribed");
      this.handlers.onConnect?.();
    });

    this.ws.on("message", (data) => {
      const recvTsMs = Date.now();
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch (err) {
        log?.warn({ err: String(err) }, "CLOB WS message parse failed");
        return;
      }

      const eventType = msg.event_type ?? msg.type ?? msg.msg_type;
      const tokenId = msg.asset_id ?? msg.token_id ?? msg.assetId ?? null;
      if (!tokenId || typeof tokenId !== "string") return;

      if (eventType === "book") {
        const bids = parseLevels(msg.bids);
        const asks = parseLevels(msg.asks);
        if (!bids.length && !asks.length) return;
        this.handlers.onBook({
          tokenId,
          marketId: msg.market ?? null,
          hash: msg.hash ?? null,
          bids,
          asks,
          recvTsMs
        });
        return;
      }

      if (eventType === "price_change" || eventType === "price_change_v2") {
        const changes = parseChanges(msg.price_changes ?? msg.changes ?? []);
        if (!changes.length) return;
        this.handlers.onPriceChange(tokenId, changes, recvTsMs);
        return;
      }

      if (eventType === "last_trade_price") {
        const price = Number(msg.price);
        const size = Number(msg.size);
        const side = msg.side === "SELL" ? "SELL" : msg.side === "BUY" ? "BUY" : null;
        const tsRaw =
          typeof msg.timestamp === "number"
            ? msg.timestamp
            : typeof msg.ts === "number"
              ? msg.ts
              : null;
        const timestamp =
          tsRaw == null
            ? null
            : tsRaw < 1_000_000_000_000
              ? tsRaw * 1000
              : tsRaw;
        if (!Number.isFinite(price) || !Number.isFinite(size) || side == null) return;
        this.handlers.onTrade?.({
          tokenId,
          marketId: msg.market ?? null,
          price,
          size,
          side,
          timestamp,
          recvTsMs
        });
      }
    });

    this.ws.on("close", () => {
      if (this.closed) return;
      this.handlers.onDisconnect?.();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.handlers.onError?.(err);
    });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    const { log } = this.handlers;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(30_000, this.reconnectDelayMs * 2);
    log?.warn({ delayMs: delay }, "CLOB WS reconnect scheduled");
    setTimeout(() => this.connect(), delay);
  }
}
