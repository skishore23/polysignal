import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  ClobUserWsClient, resolveApiCreds, type ClobAuthConfig,
  type ClobUserOrderEvent, type ClobUserTradeEvent
} from "@polysignal/data";
import type { Logger } from "../logger";
import { canTransitionOrderStatus, normalizeOrderStatus, type CanonicalOrderStatus } from "./orderStateMachine";

type UserWsConfig = ClobAuthConfig & { userWsUrl: string; userWsEnabled: boolean };
type ReceiptClock = { utc: number; mono: number };
type UserWsDeps = { sqlite: any; logger: Logger; clock?: () => ReceiptClock };
type OrderRow = {
  id: number; status: string | null; size: number | null; filledSize: number | null;
  filledPrice: number | null; tokenId: string; side: string;
};
export type UserTradeStatus = "MATCHED" | "MATCHED_NOT_BROADCASTED" | "MINED" | "CONFIRMED" | "RETRYING" | "FAILED";
export type UserTradeAllocation = { orderId: string; token: string; side: "BUY" | "SELL" | null; price: number; size: number; role: "taker" | "maker" };
export type ObservedUserTrade = { id: string; status: UserTradeStatus; allocations: UserTradeAllocation[] };
export type UserWsEvidenceState = {
  sessionId: string; connectionEpoch: number; connected: boolean; lastReceiptSequence: number;
  complete: false; completenessReason: "NO_ACCOUNT_SNAPSHOT_OR_REPLAY_COVERAGE";
  payloadScope: "PARSED_PAYLOAD_NOT_RAW_WIRE";
};
export type UserWsReconciler = {
  updateMarkets: (conditionIds: string[]) => void;
  close: () => void;
  evidenceState: () => UserWsEvidenceState;
};

const EPS = 1e-9;
const statuses = new Set<string>(["MATCHED", "MATCHED_NOT_BROADCASTED", "MINED", "CONFIRMED", "RETRYING", "FAILED"]);
function requireValue(ok: unknown, reason: string): asserts ok {
  if (!ok) throw Error("user_ws:" + reason);
}
function object(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "object_required");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  requireValue(typeof value === "string" && value.length > 0 && value.trim() === value, "identifier");
  return value;
}
function decimal(value: unknown): number {
  requireValue((typeof value === "string" && /^(0|[1-9]\d*)(\.\d+)?$/.test(value))
    || (typeof value === "number" && Number.isFinite(value)), "decimal");
  const result = Number(value);
  requireValue(Number.isFinite(result) && result >= 0 && result <= Number.MAX_SAFE_INTEGER, "decimal_range");
  return result;
}
function allocation(row: Record<string, unknown>, role: "taker" | "maker"): UserTradeAllocation {
  const price = decimal(row.price), size = decimal(role === "taker" ? row.size : row.matched_amount);
  requireValue(price > 0 && price < 1 && size > EPS, "allocation_domain");
  requireValue(row.side === "BUY" || row.side === "SELL" || (role === "maker" && row.side == null), "allocation_side");
  return { orderId: identifier(role === "taker" ? row.taker_order_id : row.order_id),
    token: identifier(row.asset_id), side: row.side === "BUY" || row.side === "SELL" ? row.side : null, price, size, role };
}
function tradeHeader(value: unknown) {
  const row = object(value), id = identifier(row.id);
  requireValue(typeof row.status === "string" && statuses.has(row.status), "trade_status");
  return { row, id, status: row.status as UserTradeStatus };
}
function consistentIdentity(before: Record<string, unknown>, after: Record<string, unknown>, confirmed = false): void {
  if (confirmed && typeof before.transaction_hash === "string" && before.transaction_hash.length > 0
    && typeof after.transaction_hash === "string" && after.transaction_hash.length > 0)
    requireValue(before.transaction_hash === after.transaction_hash, "conflicting_confirmation_transaction");
  for (const key of ["taker_order_id", "asset_id", "side", "market", "owner", "trade_owner", "trader_side"]) {
    if (typeof before[key] === "string" && typeof after[key] === "string")
      requireValue(before[key] === after[key], "conflicting_trade_identity");
  }
  for (const key of ["price", "size", "matched_amount"]) {
    if (before[key] != null && after[key] != null) {
      let oldValue: number, newValue: number;
      try { oldValue = decimal(before[key]); newValue = decimal(after[key]); }
      catch { continue; } // An invalid/missing field can be enriched, never invented.
      requireValue(oldValue === newValue, "conflicting_trade_identity");
    }
  }
  if (confirmed && Array.isArray(before.maker_orders)) {
    let complete = false;
    try { decodeObservedUserTrade(before); complete = true; } catch { /* Earlier incomplete shape may be enriched. */ }
    if (complete) {
      requireValue(Array.isArray(after.maker_orders) && after.maker_orders.length === before.maker_orders.length,
        "conflicting_duplicate_trade");
      const ids = new Set(after.maker_orders.map(x => x?.order_id));
      requireValue(before.maker_orders.every(x => ids.has(x.order_id)), "conflicting_duplicate_trade");
    }
  }
  if (Array.isArray(before.maker_orders) && Array.isArray(after.maker_orders)) {
    const makers = after.maker_orders.filter(x => x && typeof x === "object") as Record<string, unknown>[];
    for (const value of before.maker_orders) {
      if (!value || typeof value !== "object" || typeof value.order_id !== "string") continue;
      const next = makers.find(x => x.order_id === value.order_id);
      requireValue(next, "conflicting_duplicate_trade");
      consistentIdentity(value as Record<string, unknown>, next);
    }
  }
}
/** Raw legacy wire fields survive the pinned producer's type cast. Validate them here. */
export function decodeObservedUserTrade(value: unknown): ObservedUserTrade {
  const { row, id, status } = tradeHeader(value);
  requireValue(row.maker_orders == null || Array.isArray(row.maker_orders), "maker_orders");
  const allocations = [allocation(row, "taker"), ...(row.maker_orders as unknown[] | undefined ?? [])
    .map(maker => allocation(object(maker), "maker"))];
  requireValue(new Set(allocations.map(x => x.orderId)).size === allocations.length, "duplicate_allocation");
  return { id, status, allocations };
}

export async function startUserWsReconciler(
  config: UserWsConfig, deps: UserWsDeps, initialMarkets: string[]
): Promise<UserWsReconciler | null> {
  if (!config.userWsEnabled) return null;
  const apiCreds = await resolveApiCreds(config);
  if (!apiCreds) { deps.logger.warn("User WS disabled: missing POLY_API_* creds and POLY_PRIVATE_KEY"); return null; }
  // Only the caller's already-open database is used. No historical rows are backfilled.
  deps.sqlite.exec(`CREATE TABLE IF NOT EXISTS user_ws_receipts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    connection_epoch INTEGER NOT NULL, received_utc_ms INTEGER NOT NULL, received_mono_ms REAL NOT NULL,
    kind TEXT NOT NULL, event_id TEXT, trade_status TEXT, payload_json TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL, projection_status TEXT NOT NULL, projection_error TEXT,
    completeness TEXT NOT NULL CHECK(completeness='UNVERIFIED'), trade_header_valid INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS user_ws_receipts_event_idx ON user_ws_receipts(kind,event_id,sequence);`);
  const state: UserWsEvidenceState = { sessionId: randomUUID(), connectionEpoch: 0, connected: false,
    lastReceiptSequence: 0, complete: false, completenessReason: "NO_ACCOUNT_SNAPSHOT_OR_REPLAY_COVERAGE",
    payloadScope: "PARSED_PAYLOAD_NOT_RAW_WIRE" };
  const clock = deps.clock ?? (() => ({ utc: Date.now(), mono: performance.now() }));
  let closed = false;
  const insertReceipt = deps.sqlite.prepare(`INSERT INTO user_ws_receipts
    (session_id,connection_epoch,received_utc_ms,received_mono_ms,kind,event_id,trade_status,
     payload_json,payload_sha256,projection_status,completeness,trade_header_valid)
    VALUES (@session,@epoch,@utc,@mono,@kind,@id,@status,@payload,@sha,'RECEIVED','UNVERIFIED',@headerValid)`);
  const finishReceipt = deps.sqlite.prepare(`UPDATE user_ws_receipts SET projection_status=?,projection_error=? WHERE sequence=?`);
  const orderByExternal = deps.sqlite.prepare(`SELECT id,status,size,filled_size AS filledSize,
    filled_price AS filledPrice,token_id AS tokenId,side FROM shadow_orders WHERE external_order_id=?`);
  const updateOrder = deps.sqlite.prepare(`UPDATE shadow_orders SET status=@status,filled_size=@filledSize,
    filled_price=@filledPrice,last_update_ts=@at WHERE id=@id`);
  const orderFills = deps.sqlite.prepare(`SELECT price,size,note,trade_id AS tradeId FROM shadow_fills WHERE order_id=?`);
  const insertFill = deps.sqlite.prepare(`INSERT INTO shadow_fills (ts,order_id,price,size,method,note,trade_id)
    VALUES (@ts,@orderId,@price,@size,'trade_match',@note,@tradeId)`);
  const priorTrades = deps.sqlite.prepare(`SELECT trade_status AS status,payload_json AS payload FROM user_ws_receipts
    WHERE kind='trade' AND event_id=? AND trade_header_valid=1 AND sequence<?
      AND projection_status<>'NONFINAL_AFTER_TERMINAL' ORDER BY sequence`);

  function findOrder(id: string): OrderRow | null {
    const rows = orderByExternal.all(id) as OrderRow[];
    requireValue(rows.length <= 1, "ambiguous_external_order"); return rows[0] ?? null;
  }
  function observed(kind: "order" | "trade" | "connection", payload: unknown,
    project: (at: ReceiptClock, sequence: number) => string): void {
    const at = clock();
    requireValue(Number.isSafeInteger(at.utc) && at.utc >= 0 && Number.isFinite(at.mono) && at.mono >= 0, "receipt_clock");
    const raw = JSON.stringify(payload) ?? "null";
    const row = payload !== null && typeof payload === "object" ? payload as Record<string, unknown> : {};
    let headerValid = 0;
    if (kind === "trade" && state.connected) {
      try { tradeHeader(payload); headerValid = 1; } catch { /* Pure validation only; no database error is swallowed. */ }
    }
    const result = insertReceipt.run({ session: state.sessionId, epoch: state.connectionEpoch,
      utc: at.utc, mono: at.mono, kind, id: typeof row.id === "string" ? row.id : null,
      status: typeof row.status === "string" ? row.status : null, payload: raw,
      sha: createHash("sha256").update(raw).digest("hex"), headerValid });
    const sequence = Number(result.lastInsertRowid); state.lastReceiptSequence = sequence;
    // Header evidence is atomic with the observed payload and survives projection rollback.
    // Retain the observation even if the entire projection transaction rolls back.
    try { deps.sqlite.transaction(() => { finishReceipt.run(project(at, sequence), null, sequence); })(); }
    catch (error) {
      finishReceipt.run("REJECTED", String(error), sequence);
      deps.logger.warn({ receiptSequence: sequence, err: String(error) }, "User WS projection rejected; observation retained");
    }
  }
  function projectAllocation(trade: ObservedUserTrade, fill: UserTradeAllocation, at: ReceiptClock): boolean {
    const row = findOrder(fill.orderId); if (!row) return false;
    requireValue(row.tokenId === fill.token && (row.side === "BUY" || row.side === "SELL")
      && (fill.side === null || row.side === fill.side), "allocation_order_identity");
    const current = row.status === null ? "OPEN" : normalizeOrderStatus(row.status);
    requireValue(current !== null && current !== "REJECTED", "existing_order_status");
    requireValue(typeof row.size === "number" && row.size > 0 && Number.isFinite(row.size), "existing_order_size");
    const previous = orderFills.all(row.id) as { price: number; size: number; note: string | null; tradeId: string | null }[];
    requireValue(previous.every(x => (x.note === "user_ws:taker:CONFIRMED" || x.note === "user_ws:maker:CONFIRMED")
      && Number.isFinite(x.price) && x.price > 0 && x.price < 1 && Number.isFinite(x.size) && x.size > EPS
      && typeof x.tradeId === "string" && x.tradeId.length > 0), "unverified_existing_fill_projection");
    const priorSize = previous.reduce((s, x) => s + x.size, 0);
    requireValue(Math.abs((row.filledSize ?? 0) - priorSize) <= EPS, "unverified_existing_fill_projection");
    const priorCash = previous.reduce((s, x) => s + x.size * x.price, 0);
    requireValue(priorSize <= EPS || (row.filledPrice !== null && Number.isFinite(row.filledPrice)
      && Math.abs(row.filledPrice - priorCash / priorSize) <= EPS), "unverified_existing_fill_projection");
    const duplicate = previous.find(x => x.tradeId === trade.id);
    if (duplicate) {
      requireValue(duplicate.price === fill.price && duplicate.size === fill.size
        && duplicate.note === `user_ws:${fill.role}:CONFIRMED`, "conflicting_duplicate_trade"); return true;
    }
    requireValue(priorSize + fill.size <= row.size + EPS, "order_overfill");
    insertFill.run({ ts: at.utc, orderId: row.id, price: fill.price, size: fill.size,
      note: `user_ws:${fill.role}:CONFIRMED`, tradeId: trade.id });
    const nextSize = priorSize + fill.size;
    const cash = priorCash + fill.size * fill.price;
    // A late confirmation can update cancelled inventory without reopening its remainder.
    let status: CanonicalOrderStatus = current;
    if (current !== "CANCELLED") {
      const next = nextSize >= row.size - EPS ? "FILLED" : "PARTIAL";
      requireValue(canTransitionOrderStatus(current, next), "confirmed_order_transition"); status = next;
    }
    updateOrder.run({ id: row.id, status, filledSize: nextSize, filledPrice: cash / nextSize, at: at.utc });
    return true;
  }
  function handleTrade(event: ClobUserTradeEvent): void {
    if (closed) return;
    observed("trade", event, (at, sequence) => {
      requireValue(state.connected, "stream_disconnected");
      const header = tradeHeader(event);
      const prior = priorTrades.all(header.id, sequence) as { status: UserTradeStatus; payload: string }[];
      const terminal = prior.find(x => x.status === "CONFIRMED" || x.status === "FAILED");
      if (header.status !== "CONFIRMED" && header.status !== "FAILED" && terminal) return "NONFINAL_AFTER_TERMINAL";
      for (const earlier of prior) {
        if (earlier.status === "CONFIRMED" || earlier.status === "FAILED")
          requireValue(earlier.status === header.status || (header.status !== "CONFIRMED" && header.status !== "FAILED"), "conflicting_terminal_trade");
        consistentIdentity(object(JSON.parse(earlier.payload)), header.row,
          earlier.status === "CONFIRMED" && header.status === "CONFIRMED");
      }
      if (header.status === "FAILED") return "FAILED_RECORDED";
      if (header.status !== "CONFIRMED") return "NONFINAL_RECORDED";
      const trade = decodeObservedUserTrade(event);
      let ownedAllocations = 0;
      for (const fill of trade.allocations) if (projectAllocation(trade, fill, at)) ownedAllocations++;
      // Unowned may mean a legitimate counterparty OR a local insertion race.
      // No automatic replay/complete-account claim; retain it for explicit reconciliation.
      return ownedAllocations ? "CONFIRMED_RECORDED" : "CONFIRMED_UNOWNED_DEFERRED";
    });
  }
  function handleOrder(event: ClobUserOrderEvent): void {
    if (closed) return;
    observed("order", event, at => {
      requireValue(state.connected, "stream_disconnected");
      const data = object(event), row = findOrder(identifier(data.id)); if (!row) return "UNOWNED_RECORDED";
      const current = row.status === null ? "OPEN" : normalizeOrderStatus(row.status); requireValue(current !== null, "existing_order_status");
      if (data.asset_id != null) requireValue(data.asset_id === row.tokenId, "order_token");
      if (data.side != null) requireValue(data.side === row.side, "order_side");
      if (data.size_matched != null) decimal(data.size_matched); // Observed matching, never settled inventory.
      const cancellation = [data.type, data.order_event_type]
        .some(value => typeof value === "string" && value.toUpperCase() === "CANCELLATION");
      if (cancellation && data.status != null)
        requireValue(data.status === "CANCELED" || data.status === "CANCELLED", "conflicting_order_cancellation");
      const incoming = cancellation ? "CANCELLED" : data.status === "LIVE" ? "OPEN" : data.status === "CANCELED" ? "CANCELLED" : normalizeOrderStatus(data.status);
      let status = current;
      if (incoming && canTransitionOrderStatus(current, incoming)) {
        // Order MATCHED/cumulative counters do not prove a confirmed trade.
        if ((incoming !== "FILLED" || (row.size != null && (row.filledSize ?? 0) >= row.size - EPS))
          && (incoming !== "PARTIAL" || (row.filledSize ?? 0) > EPS)) status = incoming;
      }
      updateOrder.run({ id: row.id, status, filledSize: row.filledSize, filledPrice: row.filledPrice, at: at.utc });
      return "ORDER_STATE_ONLY";
    });
  }
  const marker = (event: string) => observed("connection", { event }, () => "CONNECTION_MARKER");
  marker("SESSION_START_NO_SNAPSHOT_OR_REPLAY_PROOF");
  const client = new ClobUserWsClient({ url: config.userWsUrl,
    auth: { apiKey: apiCreds.key, secret: apiCreds.secret, passphrase: apiCreds.passphrase }, markets: initialMarkets,
    handlers: { log: deps.logger, onOrder: handleOrder, onTrade: handleTrade,
      onConnect: () => { if (closed) return; state.connectionEpoch++; state.connected = true; marker("CONNECTED"); },
      onDisconnect: () => { if (closed) return; state.connected = false; marker("DISCONNECTED_GAP"); },
      onError: error => { if (closed) return; state.connected = false; marker("TRANSPORT_ERROR_GAP"); deps.logger.warn({ err: String(error) }, "User WS error"); },
    } });
  client.connect();
  return { updateMarkets: conditionIds => client.updateMarkets(conditionIds), evidenceState: () => ({ ...state }),
    close: () => { if (closed) return; closed = true; state.connected = false; marker("LOCAL_CLOSE"); client.close(); } };
}
