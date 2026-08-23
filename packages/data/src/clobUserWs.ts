import WebSocket from "ws";
import type { LoggerLike } from "@polysignal/utils";

export type ClobUserWsAuth = {
  apiKey: string;
  secret: string;
  passphrase: string;
};

export type ClobUserOrderEvent = {
  id: string;
  status?: string;
  size_matched?: string | number;
  original_size?: string | number;
  price?: string | number;
  side?: string;
  asset_id?: string;
  owner?: string;
  created_at?: number | string;
  expiration?: number | string;
  maker_fee_rate?: string | number;
  taker_fee_rate?: string | number;
};

export type ClobUserTradeEvent = {
  id: string;
  price?: string | number;
  side?: string;
  size?: string | number;
  asset_id?: string;
  taker_order_id?: string;
  timestamp?: number | string;
  maker_orders?: Array<{ order_id: string; matched_amount: string | number }>;
};

export type ClobUserWsHandlers = {
  onOrder?: (event: ClobUserOrderEvent) => void;
  onTrade?: (event: ClobUserTradeEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (err: unknown) => void;
  log?: LoggerLike;
};

export type ClobUserWsClientArgs = {
  url: string;
  auth: ClobUserWsAuth;
  markets: string[];
  handlers: ClobUserWsHandlers;
};

export class ClobUserWsClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private readonly url: string;
  private readonly auth: ClobUserWsAuth;
  private markets: string[];
  private readonly handlers: ClobUserWsHandlers;
  private reconnectDelayMs = 1000;

  constructor(args: ClobUserWsClientArgs) {
    this.url = args.url;
    this.auth = args.auth;
    this.markets = args.markets;
    this.handlers = args.handlers;
  }

  connect(): void {
    if (this.closed) return;
    const { log } = this.handlers;
    log?.info({ marketCount: this.markets.length }, "User WS connecting");
    this.ws = new WebSocket(this.url);

    this.ws.on("open", () => {
      this.reconnectDelayMs = 1000;
      this.sendSubscribe();
      this.handlers.onConnect?.();
    });

    this.ws.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch (err) {
        log?.warn({ err: String(err) }, "User WS message parse failed");
        return;
      }

      const eventType = msg.event_type ?? msg.type ?? msg.eventType;
      const payload = msg.data ?? msg.payload ?? msg;

      if (eventType === "order") {
        this.handlers.onOrder?.(payload as ClobUserOrderEvent);
        return;
      }
      if (eventType === "trade") {
        this.handlers.onTrade?.(payload as ClobUserTradeEvent);
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

  updateMarkets(markets: string[]): void {
    this.markets = markets;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscribe();
    }
  }

  private sendSubscribe(): void {
    const payload = {
      type: "user",
      markets: this.markets,
      auth: {
        apiKey: this.auth.apiKey,
        secret: this.auth.secret,
        passphrase: this.auth.passphrase
      }
    };
    this.ws?.send(JSON.stringify(payload));
  }

  private scheduleReconnect(): void {
    const { log } = this.handlers;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(30_000, this.reconnectDelayMs * 2);
    log?.warn({ delayMs: delay }, "User WS reconnect scheduled");
    setTimeout(() => this.connect(), delay);
  }
}
