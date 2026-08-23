import { ClobRestClient, createClobClient, type ClobAuthConfig } from "@polysignal/data";
import { OrderType, Side } from "@polymarket/clob-client";
import type { Logger } from "../logger";
import { normalizeOrderStatus, type CanonicalOrderStatus } from "./orderStateMachine";
import { CLOB_BATCH_ORDER_CAP } from "../trading/PolymarketFeeMath";

export type LiveExecutionConfig = ClobAuthConfig & {
  enabled: boolean;
};

export type LiveOrderKind = "MAKER_BID" | "MAKER_ASK" | "TAKER_BUY" | "TAKER_SELL";

export type LiveOrderRequest = {
  walletId: number;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  kind: LiveOrderKind;
  reason: string;
  decisionGroupId?: string;
  feeRateBps?: number | null;
  postOnly?: boolean;
};

export type LiveOrderResult = {
  clientOrderId: string;
  externalOrderId: string | null;
  status: CanonicalOrderStatus | null;
  filledSize: number | null;
  filledPrice: number | null;
  error?: string | null;
};

type LiveExecutionDeps = {
  logger: Logger;
};

type OrderMeta = {
  tickSize: number;
  negRisk: boolean;
  minOrderSize: number | null;
  feeRateBps: number | null;
};

const buildClientOrderId = (order: LiveOrderRequest, ts: number): string =>
  `${order.walletId}:${order.tokenId}:${ts}:${order.side}:${order.price.toFixed(4)}:${order.size.toFixed(2)}:${order.kind}:${order.decisionGroupId ?? "none"}`;

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const roundToTick = (price: number, tickSize: number): number => {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) return price;
  const steps = Math.round(price / tickSize);
  return Number((steps * tickSize).toFixed(10));
};

const parseLiveOrderResponse = (response: unknown): {
  externalOrderId: string;
  status: CanonicalOrderStatus;
  filledSize: number | null;
  filledPrice: number | null;
} => {
  if (typeof response !== "object" || response == null) {
    throw new Error("Invalid live order response: expected object");
  }
  const obj = response as Record<string, unknown>;
  if (typeof obj.orderID !== "string" || obj.orderID.length === 0) {
    throw new Error("Invalid live order response: missing orderID");
  }
  const status = normalizeOrderStatus(obj.status);
  if (status == null) {
    throw new Error(`Invalid live order response: unknown status ${String(obj.status)}`);
  }

  return {
    externalOrderId: obj.orderID,
    status,
    filledSize: toNumber(obj.size_matched ?? null),
    filledPrice: toNumber(obj.price ?? null)
  };
};

const parseScoringBoolean = (raw: unknown): boolean | null => {
  if (typeof raw === "boolean") return raw;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const direct = obj.scoring ?? obj.is_scoring ?? obj.isScoring ?? obj.eligible ?? null;
  if (typeof direct === "boolean") return direct;
  return null;
};

const parseBatchScoringResponse = (orderIds: string[], raw: unknown): Record<string, boolean> | null => {
  if (!raw) return null;
  const out: Record<string, boolean> = {};

  if (Array.isArray(raw)) {
    for (const [idx, value] of raw.entries()) {
      const orderId = orderIds[idx];
      if (!orderId) continue;
      const parsed = parseScoringBoolean(value);
      if (parsed != null) out[orderId] = parsed;
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const orderId of orderIds) {
      const parsed = parseScoringBoolean(obj[orderId]);
      if (parsed != null) out[orderId] = parsed;
    }
    const items = obj.items;
    if (Array.isArray(items)) {
      for (const [idx, item] of items.entries()) {
        const orderId = orderIds[idx];
        if (!orderId) continue;
        const parsed = parseScoringBoolean(item);
        if (parsed != null) out[orderId] = parsed;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  return null;
};

export class LiveExecutionGateway {
  private readonly config: LiveExecutionConfig;
  private readonly deps: LiveExecutionDeps;
  private client: any | null = null;
  private ready = false;
  private rest = new ClobRestClient();
  private metaCache = new Map<string, { meta: OrderMeta; ts: number }>();
  private metaTtlMs = 10 * 60 * 1000;

  constructor(config: LiveExecutionConfig, deps: LiveExecutionDeps) {
    this.config = config;
    this.deps = deps;
  }

  public isEnabled(): boolean {
    return this.config.enabled && Boolean(this.config.privateKey);
  }

  public async init(): Promise<boolean> {
    if (!this.config.enabled) return false;
    if (!this.config.privateKey) {
      this.deps.logger.warn("Live execution enabled but POLY_PRIVATE_KEY is missing");
      return false;
    }
    if (this.ready) return true;
    const bundle = await createClobClient(this.config);
    if (!bundle) {
      this.deps.logger.warn("Live execution disabled: missing POLY_PRIVATE_KEY or POLY_API_* creds");
      return false;
    }
    this.client = bundle.client;
    this.ready = true;
    return true;
  }

  public async placeMakerOrder(order: LiveOrderRequest): Promise<LiveOrderResult | null> {
    return await this.placeOrder(
      {
        ...order,
        postOnly: order.postOnly ?? true
      },
      OrderType.GTC
    );
  }

  public async placeTakerOrder(order: LiveOrderRequest): Promise<LiveOrderResult | null> {
    return await this.placeOrder(
      {
        ...order,
        postOnly: false
      },
      OrderType.FOK
    );
  }

  public async batchPlaceOrders(
    orders: LiveOrderRequest[],
    orderType: OrderType = OrderType.FOK
  ): Promise<Array<LiveOrderResult | null>> {
    if (!orders.length) return [];
    if (!this.config.enabled) return orders.map(() => null);
    const ok = await this.init();
    if (!ok || !this.client) return orders.map(() => null);

    const clipped = orders.slice(0, CLOB_BATCH_ORDER_CAP);
    const client = this.client as Record<string, (...params: any[]) => Promise<unknown>>;
    if (typeof client.createOrder !== "function" || typeof client.postOrders !== "function") {
      const fallback: Array<LiveOrderResult | null> = [];
      for (const order of clipped) {
        fallback.push(await this.placeOrder(order, orderType));
      }
      return fallback;
    }

    type PreparedOrder = {
      order: LiveOrderRequest;
      meta: OrderMeta;
      price: number;
      clientOrderId: string;
      signed: unknown;
    };

    const prepared: PreparedOrder[] = [];
    for (const order of clipped) {
      const meta = await this.getOrderMeta(order.tokenId);
      if (!meta) {
        prepared.push({
          order,
          meta: { tickSize: 0, negRisk: false, minOrderSize: null, feeRateBps: null },
          price: NaN,
          clientOrderId: buildClientOrderId(order, Date.now()),
          signed: null
        });
        continue;
      }
      const price = roundToTick(order.price, meta.tickSize);
      const clientOrderId = buildClientOrderId(order, Date.now());
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(order.size) || order.size <= 0) {
        prepared.push({ order, meta, price, clientOrderId, signed: null });
        continue;
      }
      if (meta.minOrderSize != null && order.size < meta.minOrderSize) {
        prepared.push({ order, meta, price, clientOrderId, signed: null });
        continue;
      }

      try {
        const feeRateBps = order.feeRateBps ?? meta.feeRateBps ?? 0;
        const payload = {
          tokenID: order.tokenId,
          price,
          side: order.side === "BUY" ? Side.BUY : Side.SELL,
          size: order.size,
          feeRateBps
        };
        const options = { tickSize: meta.tickSize, negRisk: meta.negRisk };
        const signed = await client.createOrder(payload, options);
        prepared.push({ order, meta, price, clientOrderId, signed });
      } catch (err) {
        this.deps.logger.warn({ err: String(err), tokenId: order.tokenId }, "Live batch order signing failed");
        prepared.push({ order, meta, price, clientOrderId, signed: null });
      }
    }

    const signedOrders = prepared.filter((p) => p.signed != null).map((p) => p.signed);
    if (!signedOrders.length) {
      return prepared.map(() => null);
    }

    let rawResponse: unknown = null;
    try {
      const defaultPostOnly = prepared.every((p) => p.order.postOnly === true);
      try {
        rawResponse = await client.postOrders(signedOrders, false, defaultPostOnly);
      } catch {
        rawResponse = await client.postOrders(signedOrders);
      }
    } catch (err) {
      this.deps.logger.warn({ err: String(err) }, "Live batch postOrders failed; falling back to single placement");
      const fallback: Array<LiveOrderResult | null> = [];
      for (const order of clipped) {
        fallback.push(await this.placeOrder(order, orderType));
      }
      return fallback;
    }

    const responses = Array.isArray(rawResponse) ? rawResponse : [];
    let responseIdx = 0;
    return prepared.map((item) => {
      if (item.signed == null) {
        return {
          clientOrderId: item.clientOrderId,
          externalOrderId: null,
          status: null,
          filledSize: null,
          filledPrice: null,
          error: "invalid_batch_order"
        };
      }
      const raw = responses[responseIdx];
      responseIdx += 1;
      try {
        const parsed = parseLiveOrderResponse(raw);
        return {
          clientOrderId: item.clientOrderId,
          externalOrderId: parsed.externalOrderId,
          status: parsed.status,
          filledSize: parsed.filledSize,
          filledPrice: parsed.filledPrice,
          error: null
        };
      } catch (err) {
        return {
          clientOrderId: item.clientOrderId,
          externalOrderId: null,
          status: null,
          filledSize: null,
          filledPrice: null,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    });
  }

  public async checkOrderScoring(orderId: string): Promise<boolean | null> {
    if (!orderId) return null;
    if (!this.config.enabled) return null;
    const ok = await this.init();
    if (!ok || !this.client) return null;
    const client = this.client as Record<string, (...args: any[]) => Promise<unknown>>;
    try {
      if (typeof client.isOrderScoring === "function") {
        const response = await client.isOrderScoring({ order_id: orderId });
        return parseScoringBoolean(response);
      }
      return null;
    } catch (err) {
      this.deps.logger.debug({ err: String(err), orderId }, "Order scoring check failed");
      return null;
    }
  }

  public async checkOrdersScoring(orderIds: string[]): Promise<Record<string, boolean> | null> {
    if (!orderIds.length) return null;
    if (!this.config.enabled) return null;
    const ok = await this.init();
    if (!ok || !this.client) return null;
    const client = this.client as Record<string, (...args: any[]) => Promise<unknown>>;
    try {
      if (typeof client.areOrdersScoring !== "function") return null;
      const response = await client.areOrdersScoring({ orderIds });
      return parseBatchScoringResponse(orderIds, response);
    } catch (err) {
      this.deps.logger.debug({ err: String(err), orderIds }, "Batch order scoring check failed");
      return null;
    }
  }

  public async cancelOrder(externalOrderId: string): Promise<boolean> {
    if (!externalOrderId) return false;
    if (!this.config.enabled) return false;
    const ok = await this.init();
    if (!ok || !this.client) return false;
    const client = this.client as Record<string, (...args: any[]) => Promise<unknown>>;
    try {
      if (typeof client.cancel === "function") {
        await client.cancel(externalOrderId);
        return true;
      }
      if (typeof client.cancelOrder === "function") {
        await client.cancelOrder(externalOrderId);
        return true;
      }
      if (typeof client.cancelOrders === "function") {
        await client.cancelOrders([externalOrderId]);
        return true;
      }
      this.deps.logger.warn({ externalOrderId }, "Cancel method unavailable on CLOB client");
      return false;
    } catch (err) {
      this.deps.logger.warn({ err: String(err), externalOrderId }, "Cancel order failed");
      return false;
    }
  }

  public async cancelReplace(
    cancelExternalOrderId: string,
    nextOrder: LiveOrderRequest,
    orderType: OrderType = OrderType.GTC
  ): Promise<LiveOrderResult | null> {
    await this.cancelOrder(cancelExternalOrderId);
    return await this.placeOrder(nextOrder, orderType);
  }

  private async placeOrder(order: LiveOrderRequest, orderType: OrderType): Promise<LiveOrderResult | null> {
    if (!this.config.enabled) return null;
    const ok = await this.init();
    if (!ok || !this.client) return null;

    const meta = await this.getOrderMeta(order.tokenId);
    if (!meta) return null;

    const price = roundToTick(order.price, meta.tickSize);
    if (!Number.isFinite(price) || price <= 0) return null;
    if (!Number.isFinite(order.size) || order.size <= 0) return null;
    if (meta.minOrderSize != null && order.size < meta.minOrderSize) {
      this.deps.logger.warn(
        { tokenId: order.tokenId, size: order.size, minOrderSize: meta.minOrderSize },
        "Live order below min size; skipping"
      );
      return null;
    }

    const clientOrderId = buildClientOrderId(order, Date.now());

    try {
      const response = await this.createAndSubmitOrder({
        order,
        meta,
        price,
        orderType
      });

      const parsed = parseLiveOrderResponse(response);

      return {
        clientOrderId,
        externalOrderId: parsed.externalOrderId,
        status: parsed.status,
        filledSize: parsed.filledSize,
        filledPrice: parsed.filledPrice,
        error: null
      };
    } catch (err) {
      this.deps.logger.warn({ err: String(err), tokenId: order.tokenId }, "Live order failed");
      return {
        clientOrderId,
        externalOrderId: null,
        status: null,
        filledSize: null,
        filledPrice: null,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  private async createAndSubmitOrder(args: {
    order: LiveOrderRequest;
    meta: OrderMeta;
    price: number;
    orderType: OrderType;
  }): Promise<unknown> {
    const client = this.client as Record<string, (...params: any[]) => Promise<unknown>>;
    const feeRateBps = args.order.feeRateBps ?? args.meta.feeRateBps ?? 0;
    const payload = {
      tokenID: args.order.tokenId,
      price: args.price,
      side: args.order.side === "BUY" ? Side.BUY : Side.SELL,
      size: args.order.size,
      feeRateBps
    };
    const options = {
      tickSize: args.meta.tickSize,
      negRisk: args.meta.negRisk
    };

    if (typeof client.createAndPostOrder === "function") {
      return await client.createAndPostOrder(payload, options, args.orderType, Boolean(args.order.postOnly));
    }
    if (typeof client.createOrder === "function" && typeof client.postOrder === "function") {
      const signed = await client.createOrder(payload, options);
      return await client.postOrder(signed, args.orderType, Boolean(args.order.postOnly));
    }
    throw new Error("CLOB client does not expose order placement methods");
  }

  private async getOrderMeta(tokenId: string): Promise<OrderMeta | null> {
    const cached = this.metaCache.get(tokenId);
    const now = Date.now();
    if (cached && now - cached.ts < this.metaTtlMs) return cached.meta;

    try {
      const [book, feeRateBps] = await Promise.all([
        this.rest.getBook(tokenId, this.deps.logger),
        this.rest.getFeeRateBps(tokenId)
      ]);
      const tickSize = toNumber(book.tick_size);
      if (!tickSize || !Number.isFinite(tickSize) || tickSize <= 0) {
        this.deps.logger.warn({ tokenId }, "Live order missing tick size");
        return null;
      }
      const negRisk = Boolean(book.neg_risk);
      const minOrderSize = toNumber(book.min_order_size);
      const meta: OrderMeta = {
        tickSize,
        negRisk,
        minOrderSize,
        feeRateBps
      };
      this.metaCache.set(tokenId, { meta, ts: now });
      return meta;
    } catch (err) {
      this.deps.logger.warn({ err: String(err), tokenId }, "Live order meta fetch failed");
      return null;
    }
  }
}
