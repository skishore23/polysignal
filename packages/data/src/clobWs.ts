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
      const side = item[2] === "SELL" ? "SELL" : item[2] === "BUY" ? "BUY" : null;
      if (Number.isFinite(price) && Number.isFinite(size) && side != null) {
        changes.push({ price, size, side });
      }
      continue;
    }
    if (typeof item === "object" && item !== null) {
      const price = Number((item as { price?: unknown }).price);
      const size = Number((item as { size?: unknown }).size);
      const rawSide = (item as { side?: unknown }).side;
      const side = rawSide === "SELL" ? "SELL" : rawSide === "BUY" ? "BUY" : null;
      const hash = (item as { hash?: string | null }).hash ?? null;
      if (Number.isFinite(price) && Number.isFinite(size) && side != null) {
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
      this.clearHeartbeat();
      const socket = this.ws;
      this.heartbeatTimer = setInterval(() => {
        if (!this.closed && socket === this.ws && socket?.readyState === WebSocket.OPEN) {
          socket.send("PING");
        }
      }, 10_000);
      log?.info({ assetCount: this.assetIds.length }, "CLOB WS subscribed");
      this.handlers.onConnect?.();
    });

    this.ws.on("message", (data) => {
      const recvTsMs = Date.now();
      if (String(data) === "PONG") return;
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch (err) {
        log?.warn({ err: String(err) }, "CLOB WS message parse failed");
        return;
      }
      // Valid JSON can still be a non-event (notably null). Do not let a
      // malformed frame escape the listener or acquire market semantics.
      if (msg == null || typeof msg !== "object" || Array.isArray(msg)) return;

      const eventType = msg.event_type ?? msg.type ?? msg.msg_type;
      const tokenId = msg.asset_id ?? msg.token_id ?? msg.assetId ?? null;

      // Current market frames carry asset_id on each change, not on the envelope.
      // Keep the original per-token handler contract and legacy top-level frames.
      if (eventType === "price_change" || eventType === "price_change_v2") {
        const rawChanges = msg.price_changes ?? msg.changes ?? [];
        if (!Array.isArray(rawChanges)) return;
        const byToken = new Map<string, ClobWsPriceChange[]>();
        for (const raw of rawChanges) {
          const id = raw != null && typeof raw === "object" && !Array.isArray(raw)
            ? raw.asset_id ?? raw.token_id ?? raw.assetId ?? tokenId
            : tokenId;
          if (typeof id !== "string" || !id) continue;
          const changes = parseChanges([raw]);
          if (!changes.length) continue;
          const group = byToken.get(id) ?? [];
          group.push(...changes);
          byToken.set(id, group);
        }
        for (const [id, changes] of byToken) {
          this.handlers.onPriceChange(id, changes, recvTsMs);
        }
        return;
      }
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
        const numericTimestamp =
          tsRaw == null
            ? null
            : tsRaw < 1_000_000_000_000
              ? tsRaw * 1000
              : tsRaw;
        // Raw market API timestamps are decimal millisecond strings. Preserve
        // absent/unsupported times as unknown; retain numeric-seconds compatibility.
        const stringTimestamp = typeof msg.timestamp === "string" && /^\d+$/.test(msg.timestamp)
          ? Number(msg.timestamp)
          : null;
        const parsedTimestamp = stringTimestamp ?? numericTimestamp;
        const timestamp = parsedTimestamp != null && Number.isSafeInteger(parsedTimestamp) && parsedTimestamp >= 0
          ? parsedTimestamp
          : null;
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
      this.clearHeartbeat();
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
    this.clearHeartbeat();
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer != null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    const { log } = this.handlers;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(30_000, this.reconnectDelayMs * 2);
    log?.warn({ delayMs: delay }, "CLOB WS reconnect scheduled");
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
