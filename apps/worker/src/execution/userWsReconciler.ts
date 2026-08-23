import {
  ClobUserWsClient,
  resolveApiCreds,
  type ClobAuthConfig,
  type ClobUserOrderEvent,
  type ClobUserTradeEvent
} from "@polysignal/data";
import type { Logger } from "../logger";
import {
  canTransitionOrderStatus,
  isActiveOrderStatus,
  normalizeOrderStatus,
  type CanonicalOrderStatus
} from "./orderStateMachine";

type UserWsConfig = ClobAuthConfig & {
  userWsUrl: string;
  userWsEnabled: boolean;
};

type UserWsDeps = {
  sqlite: any;
  logger: Logger;
};

const FILL_EPS = 1e-9;

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const toTimestampMs = (value: unknown, fallbackMs: number): number => {
  const n = toNumber(value);
  if (n == null) return fallbackMs;
  return n < 1_000_000_000_000 ? n * 1000 : n;
};

export type UserWsReconciler = {
  updateMarkets: (conditionIds: string[]) => void;
  close: () => void;
};

export async function startUserWsReconciler(
  config: UserWsConfig,
  deps: UserWsDeps,
  initialMarkets: string[]
): Promise<UserWsReconciler | null> {
  if (!config.userWsEnabled) return null;

  const apiCreds = await resolveApiCreds(config);
  if (!apiCreds) {
    deps.logger.warn("User WS disabled: missing POLY_API_* creds and POLY_PRIVATE_KEY");
    return null;
  }

  const selectOrderByExternalIdStmt = deps.sqlite.prepare(
    `SELECT id,
            status,
            size,
            filled_size as filledSize,
            filled_price as filledPrice
     FROM shadow_orders
     WHERE external_order_id = ?
     LIMIT 1`
  );
  const updateOrderStmt = deps.sqlite.prepare(
    `UPDATE shadow_orders
     SET status = @status,
         filled_size = @filledSize,
         filled_price = @filledPrice,
         last_update_ts = @lastUpdateTs
     WHERE id = @id`
  );
  const insertFillStmt = deps.sqlite.prepare(
    `INSERT OR IGNORE INTO shadow_fills
     (ts, order_id, price, size, method, note, trade_id)
     VALUES (@ts, @orderId, @price, @size, @method, @note, @tradeId)`
  );

  const applyTradeFill = (row: {
    id: number;
    status: string | null;
    size: number | null;
    filledSize: number | null;
    filledPrice: number | null;
  }, fillPrice: number, fillSize: number, fillTs: number): void => {
    if (!Number.isFinite(fillPrice) || !Number.isFinite(fillSize) || fillSize <= FILL_EPS) return;

    const currentStatus = normalizeOrderStatus(row.status);
    if (row.status != null && currentStatus == null) {
      deps.logger.warn(
        { orderId: row.id, status: row.status },
        "User WS trade fill skipped due to unknown existing status"
      );
      return;
    }
    if (!isActiveOrderStatus(currentStatus)) {
      return;
    }

    const orderSize = Number.isFinite(row.size) && (row.size as number) > 0 ? (row.size as number) : null;
    const prevFilledSize = Number.isFinite(row.filledSize) ? (row.filledSize as number) : 0;
    const remaining = orderSize != null ? Math.max(0, orderSize - prevFilledSize) : fillSize;
    const acceptedFill = Math.min(fillSize, remaining);
    if (acceptedFill <= FILL_EPS) return;

    const nextFilledSize = prevFilledSize + acceptedFill;
    const prevFilledPrice = Number.isFinite(row.filledPrice) ? (row.filledPrice as number) : null;
    const nextFilledPrice =
      prevFilledPrice != null && prevFilledSize > FILL_EPS
        ? ((prevFilledPrice * prevFilledSize) + (fillPrice * acceptedFill)) / nextFilledSize
        : fillPrice;

    let nextStatus: CanonicalOrderStatus = currentStatus ?? "OPEN";
    if (orderSize != null && nextFilledSize >= orderSize - FILL_EPS) {
      if (canTransitionOrderStatus(nextStatus, "FILLED")) nextStatus = "FILLED";
      else return;
    } else if (nextFilledSize > FILL_EPS && (nextStatus === "OPEN" || nextStatus === "PENDING")) {
      if (canTransitionOrderStatus(nextStatus, "PARTIAL")) nextStatus = "PARTIAL";
      else return;
    }

    updateOrderStmt.run({
      id: row.id,
      status: nextStatus,
      filledSize: nextFilledSize,
      filledPrice: nextFilledPrice,
      lastUpdateTs: fillTs
    });
  };

  const handleOrder = (event: ClobUserOrderEvent) => {
    if (!event?.id) return;
    const row = selectOrderByExternalIdStmt.get(event.id) as
      | {
          id: number;
          status: string | null;
          size: number | null;
          filledSize: number | null;
          filledPrice: number | null;
        }
      | undefined;
    if (!row) return;

    const currentStatus = normalizeOrderStatus(row.status);
    if (row.status != null && currentStatus == null) {
      deps.logger.warn(
        { externalOrderId: event.id, status: row.status },
        "User WS order update skipped due to unknown existing status"
      );
      return;
    }
    const incomingStatus = normalizeOrderStatus(event.status);
    if (event.status != null && incomingStatus == null) {
      deps.logger.warn(
        { externalOrderId: event.id, status: event.status },
        "User WS order update ignored invalid status"
      );
    }

    let nextStatus: CanonicalOrderStatus = currentStatus ?? "OPEN";
    if (incomingStatus != null) {
      if (!canTransitionOrderStatus(currentStatus, incomingStatus)) {
        deps.logger.warn(
          { externalOrderId: event.id, fromStatus: currentStatus, toStatus: incomingStatus },
          "User WS order update ignored invalid status transition"
        );
      } else {
        nextStatus = incomingStatus;
      }
    }

    const orderSize = Number.isFinite(row.size) ? (row.size as number) : null;
    const prevFilledSize = Number.isFinite(row.filledSize) ? (row.filledSize as number) : 0;
    const incomingFilledSize = toNumber(event.size_matched ?? null);
    let nextFilledSize = prevFilledSize;
    if (incomingFilledSize != null) {
      if (incomingFilledSize + FILL_EPS < prevFilledSize) {
        deps.logger.warn(
          {
            externalOrderId: event.id,
            currentFilledSize: prevFilledSize,
            incomingFilledSize
          },
          "User WS order update ignored stale filled_size regression"
        );
      } else {
        nextFilledSize = incomingFilledSize;
      }
    }

    if (orderSize != null && nextFilledSize >= orderSize - FILL_EPS) {
      if (canTransitionOrderStatus(nextStatus, "FILLED")) {
        nextStatus = "FILLED";
      }
      nextFilledSize = Math.max(orderSize, nextFilledSize);
    } else if (nextFilledSize > FILL_EPS && (nextStatus === "OPEN" || nextStatus === "PENDING")) {
      if (canTransitionOrderStatus(nextStatus, "PARTIAL")) {
        nextStatus = "PARTIAL";
      }
    }

    const incomingFilledPrice = toNumber(event.price ?? null);
    const nextFilledPrice =
      incomingFilledPrice != null
        ? incomingFilledPrice
        : Number.isFinite(row.filledPrice)
          ? (row.filledPrice as number)
          : null;
    const updatedTs = toTimestampMs(event.created_at ?? Date.now(), Date.now());

    updateOrderStmt.run({
      id: row.id,
      status: nextStatus,
      filledSize: nextFilledSize > FILL_EPS ? nextFilledSize : 0,
      filledPrice: nextFilledPrice,
      lastUpdateTs: updatedTs,
    });
  };

  const handleTrade = (event: ClobUserTradeEvent) => {
    if (!event?.id) return;
    const tradeId = String(event.id);
    const tradePrice = toNumber(event.price ?? null);
    const tradeSize = toNumber(event.size ?? null);
    const tradeTs = toTimestampMs(event.timestamp ?? Date.now(), Date.now());

    if (tradePrice == null) return;

    if (event.taker_order_id && tradeSize != null) {
      const row = selectOrderByExternalIdStmt.get(event.taker_order_id) as
        | {
            id: number;
            status: string | null;
            size: number | null;
            filledSize: number | null;
            filledPrice: number | null;
          }
        | undefined;
      if (row?.id) {
        const res = insertFillStmt.run({
          ts: tradeTs,
          orderId: row.id,
          price: tradePrice,
          size: tradeSize,
          method: "trade_match",
          note: "user_ws:taker",
          tradeId
        });
        if (Number(res.changes) > 0) {
          applyTradeFill(row, tradePrice, tradeSize, tradeTs);
        }
      }
    }

    if (Array.isArray(event.maker_orders)) {
      for (const maker of event.maker_orders) {
        if (!maker?.order_id) continue;
        const matched = toNumber(maker.matched_amount ?? null);
        if (matched == null || matched <= 0) continue;
        const row = selectOrderByExternalIdStmt.get(maker.order_id) as
          | {
              id: number;
              status: string | null;
              size: number | null;
              filledSize: number | null;
              filledPrice: number | null;
            }
          | undefined;
        if (!row?.id) continue;
        const res = insertFillStmt.run({
          ts: tradeTs,
          orderId: row.id,
          price: tradePrice,
          size: matched,
          method: "trade_match",
          note: "user_ws:maker",
          tradeId
        });
        if (Number(res.changes) > 0) {
          applyTradeFill(row, tradePrice, matched, tradeTs);
        }
      }
    }
  };

  const client = new ClobUserWsClient({
    url: config.userWsUrl,
    auth: {
      apiKey: apiCreds.key,
      secret: apiCreds.secret,
      passphrase: apiCreds.passphrase
    },
    markets: initialMarkets,
    handlers: {
      log: deps.logger,
      onOrder: handleOrder,
      onTrade: handleTrade,
      onConnect: () => deps.logger.info("User WS connected"),
      onDisconnect: () => deps.logger.warn("User WS disconnected"),
      onError: (err) => deps.logger.warn({ err: String(err) }, "User WS error")
    }
  });

  client.connect();

  return {
    updateMarkets: (conditionIds: string[]) => client.updateMarkets(conditionIds),
    close: () => client.close()
  };
}
