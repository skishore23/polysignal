import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { startUserWsReconciler, type UserWsReconciler } from "../../apps/worker/src/execution/userWsReconciler";

type Socket = { emit: (name: string, data?: unknown) => boolean; close: () => void };
const sockets = vi.hoisted(() => [] as Socket[]);
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class MockSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); sockets.push(this); }
    send() { /* Authored offline transport: never creates a network socket. */ }
    close() { this.emit("close"); }
  }
  return { default: MockSocket };
});

const UTC = 1_800_000_000_000;
const owned: Array<{ db: Database.Database; client: UserWsReconciler }> = [];
afterEach(() => {
  const resources = owned.splice(0);
  for (const x of resources) x.client.close();
  for (const db of new Set(resources.map(x => x.db))) db.close();
  sockets.splice(0); vi.restoreAllMocks(); vi.useRealTimers();
});

async function fixture(existing?: Database.Database) {
  const db = existing ?? new Database(":memory:");
  if (!existing) {
  db.exec(`CREATE TABLE shadow_orders (
    id INTEGER PRIMARY KEY, external_order_id TEXT, token_id TEXT, side TEXT,
    status TEXT, size REAL, filled_size REAL, filled_price REAL, last_update_ts INTEGER);
    CREATE TABLE shadow_fills (id INTEGER PRIMARY KEY, ts INTEGER, order_id INTEGER,
      price REAL, size REAL, method TEXT, note TEXT, trade_id TEXT);
    CREATE UNIQUE INDEX shadow_fills_order_trade_idx ON shadow_fills(order_id,trade_id);`);
  db.prepare("INSERT INTO shadow_orders VALUES (1,'take','A','BUY','OPEN',10,0,NULL,0)").run();
  db.prepare("INSERT INTO shadow_orders VALUES (2,'make','B','SELL','OPEN',10,0,NULL,0)").run();
  }
  vi.spyOn(Date, "now").mockReturnValue(UTC);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
  const client = await startUserWsReconciler({
    host: "https://authored.invalid", chainId: 137, privateKey: null, signatureType: 0,
    apiKey: "offline-key", apiSecret: "offline-secret", apiPassphrase: "offline-passphrase",
    funder: null, userWsEnabled: true, userWsUrl: "wss://authored.invalid/user",
  }, { sqlite: db, logger }, []);
  expect(client).not.toBeNull(); owned.push({ db, client: client! });
  const socket = sockets[sockets.length - 1]!;
  socket.emit("open");
  const send = (event: unknown) => socket.emit("message", Buffer.from(JSON.stringify(event)));
  const row = (id = 1) => db.prepare("SELECT * FROM shadow_orders WHERE id=?").get(id) as any;
  const fills = () => db.prepare("SELECT * FROM shadow_fills ORDER BY id").all() as any[];
  const receipts = () => db.prepare("SELECT * FROM user_ws_receipts ORDER BY sequence").all() as any[];
  return { db, client: client!, socket, send, row, fills, receipts, logger };
}

function trade(extra: Record<string, unknown> = {}) {
  return { event_type: "trade", id: "trade-1", taker_order_id: "take", asset_id: "A", side: "BUY",
    price: "0.38", size: "2", status: "CONFIRMED", timestamp: String(UTC - 5000), maker_orders: [], ...extra };
}

describe("causal user stream reconciliation, authored offline messages only", () => {
  it.each(["MATCHED", "MATCHED_NOT_BROADCASTED", "MINED", "RETRYING", "FAILED", "unknown", undefined])(
    "never projects %s as a confirmed fill", async status => {
      const f = await fixture(); f.send(trade({ status }));
      expect(f.fills()).toHaveLength(0); expect(f.row().filled_size).toBe(0);
    },
  );
  it("retains pending transitions and projects a confirmed allocation only once", async () => {
    const f = await fixture();
    for (const status of ["MATCHED", "MINED", "RETRYING"]) f.send(trade({ status }));
    expect(f.fills()).toHaveLength(0);
    f.send(trade()); f.send(trade());
    expect(f.fills()).toHaveLength(1); expect(f.row().filled_size).toBe(2);
    expect(f.fills()[0].ts).toBe(UTC); // Knowledge became available at receipt, not match time.
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM shadow_fills WHERE ts<?").get(UTC)).toEqual({ n: 0 });
  });
  it("uses each maker allocation's own price, token and side instead of the taker price", async () => {
    const f = await fixture(); f.send(trade({ maker_orders: [
      { order_id: "make", matched_amount: "3", price: "0.62", asset_id: "B", side: "SELL" },
    ] }));
    expect(f.fills().map(x => [x.order_id, x.price, x.size])).toEqual([[1, .38, 2], [2, .62, 3]]);
    expect(f.row(2).filled_price).toBe(.62);
  });
  it("does not count cumulative matched size and the later identified confirmation twice", async () => {
    const f = await fixture();
    f.send({ event_type: "order", id: "take", status: "MATCHED", size_matched: "2", price: "0.45" });
    expect(f.row().filled_size).toBe(0);
    expect(f.row().status).toBe("OPEN"); expect(f.row().size - f.row().filled_size).toBe(10);
    f.send(trade()); expect(f.row().filled_size).toBe(2); expect(f.row().filled_price).toBe(.38);
    f.send({ event_type: "order", id: "take", status: "LIVE", size_matched: "2", price: "0.45" });
    expect(f.row().filled_size).toBe(2); expect(f.row().filled_price).toBe(.38);
  });
  it("rejects an overfill atomically rather than persisting a larger fill than its order projection", async () => {
    const f = await fixture(); f.send(trade({ size: "11" }));
    expect(f.fills()).toHaveLength(0); expect(f.row().filled_size).toBe(0);
  });
  it("retains exact parsed lifecycle payloads with receipt clocks and never declares completeness", async () => {
    const f = await fixture();
    for (const status of ["MATCHED", "MINED", "CONFIRMED"]) f.send(trade({ status, undocumented_extra: "retained" }));
    const events = f.receipts().filter(x => x.kind === "trade");
    expect(events.map(x => x.trade_status)).toEqual(["MATCHED", "MINED", "CONFIRMED"]);
    expect(events.map(x => x.projection_status)).toEqual(["NONFINAL_RECORDED", "NONFINAL_RECORDED", "CONFIRMED_RECORDED"]);
    for (const x of events) {
      expect(JSON.parse(x.payload_json).undocumented_extra).toBe("retained");
      expect(createHash("sha256").update(x.payload_json).digest("hex")).toBe(x.payload_sha256);
      expect(x.received_utc_ms).toBe(UTC); expect(x.received_mono_ms).toBeGreaterThanOrEqual(0);
      expect(x.completeness).toBe("UNVERIFIED");
    }
    expect(f.client.evidenceState()).toMatchObject({ complete: false, connected: true, connectionEpoch: 1,
      completenessReason: "NO_ACCOUNT_SNAPSHOT_OR_REPLAY_COVERAGE", payloadScope: "PARSED_PAYLOAD_NOT_RAW_WIRE" });
  });
  it("rolls back all allocations when a later owned allocation contradicts the original order", async () => {
    const f = await fixture(); f.send(trade({ maker_orders: [
      { order_id: "make", matched_amount: "3", price: ".62", asset_id: "WRONG", side: "SELL" },
    ] }));
    expect(f.fills()).toHaveLength(0); expect(f.row().filled_size).toBe(0);
    expect(f.receipts().at(-1)).toMatchObject({ projection_status: "REJECTED" });
    // Valid schema but wrong original identity fails after the taker projection,
    // exercising transaction rollback rather than only parser rejection.
    f.send(trade({ maker_orders: [{ order_id: "make", matched_amount: "3", price: "0.62", asset_id: "WRONG", side: "SELL" }] }));
    expect(f.fills()).toHaveLength(0); expect(f.row().filled_size).toBe(0);
    expect(f.receipts().at(-1).projection_error).toContain("allocation_order_identity");
  });
  it("keeps fill insertion and both order updates atomic on an actual SQLite failure", async () => {
    const f = await fixture(); f.db.exec(`CREATE TRIGGER authored_fail BEFORE UPDATE ON shadow_orders
      WHEN NEW.id=2 BEGIN SELECT RAISE(ABORT,'authored projection failure'); END;`);
    f.send(trade({ maker_orders: [{ order_id: "make", matched_amount: "3", price: "0.62", asset_id: "B", side: "SELL" }] }));
    expect(f.fills()).toHaveLength(0); expect(f.row().filled_size).toBe(0); expect(f.row(2).filled_size).toBe(0);
    expect(f.receipts().at(-1).projection_error).toContain("authored projection failure");
  });
  it.each(["asset", "side", "duplicate_allocation", "missing_maker_price", "boolean_size"])("rejects %s rather than inventing allocation evidence", async kind => {
    const f = await fixture(); const event: any = trade();
    if (kind === "asset") event.asset_id = "B";
    if (kind === "side") event.side = "SELL";
    if (kind === "boolean_size") event.size = true;
    if (kind === "missing_maker_price") event.maker_orders = [{ order_id: "make", matched_amount: "2", asset_id: "B", side: "SELL" }];
    if (kind === "duplicate_allocation") event.maker_orders = [{ order_id: "take", matched_amount: "2", price: "0.38", asset_id: "A", side: "BUY" }];
    f.send(event); expect(f.fills()).toHaveLength(0); expect(f.receipts().at(-1).projection_status).toBe("REJECTED");
  });
  it.each(["price", "size", "removed_maker"])("retains a contradictory confirmed %s duplicate without changing prior projections", async kind => {
    const f = await fixture(), makers = [{ order_id: "make", matched_amount: "3", price: "0.62", asset_id: "B", side: "SELL" }];
    f.send(trade({ maker_orders: makers })); const before = f.fills();
    f.send(trade({ maker_orders: kind === "removed_maker" ? [] : makers,
      ...(kind === "price" ? { price: "0.40" } : kind === "size" ? { size: "3" } : {}) }));
    expect(f.fills()).toEqual(before); expect(f.receipts().at(-1).projection_error).toMatch(/conflicting_(duplicate_trade|trade_identity)/);
  });
  it.each(["CONFIRMED", "FAILED"])("does not reverse terminal %s using a contradictory later message", async first => {
    const f = await fixture(); f.send(trade({ status: first })); const before = f.fills();
    f.send(trade({ status: first === "CONFIRMED" ? "FAILED" : "CONFIRMED" }));
    expect(f.fills()).toEqual(before); expect(f.receipts().at(-1).projection_error).toContain("conflicting_terminal_trade");
  });
  it("does not reopen cancelled remainders when a valid late confirmation arrives", async () => {
    const f = await fixture(); f.send({ event_type: "order", id: "take", status: "CANCELED", size_matched: "2" });
    expect(f.row()).toMatchObject({ status: "CANCELLED", filled_size: 0 });
    f.send(trade()); expect(f.row()).toMatchObject({ status: "CANCELLED", filled_size: 2 });
    expect(f.fills()).toHaveLength(1);
  });
  it("preserves legacy rows and rejects an unverified historical fill baseline", async () => {
    const f = await fixture();
    f.db.prepare("UPDATE shadow_orders SET filled_size=1,filled_price=.5 WHERE id=1").run();
    f.db.prepare("INSERT INTO shadow_fills VALUES(99,?,1,.5,1,'trade_match','user_ws:taker','old')").run(UTC - 10000);
    const before = f.fills(), row = f.row(); f.send(trade());
    expect(f.fills()).toEqual(before); expect(f.row()).toEqual(row);
    expect(f.receipts().at(-1).projection_error).toContain("unverified_existing_fill_projection");
  });
  it("retains connection gaps, refuses disconnected projections and never upgrades reconnect to complete", async () => {
    vi.useFakeTimers(); const f = await fixture(); f.socket.emit("close");
    expect(f.client.evidenceState()).toMatchObject({ connected: false, complete: false });
    f.send(trade()); expect(f.fills()).toHaveLength(0);
    expect(f.receipts().at(-1).projection_error).toContain("stream_disconnected");
    await vi.advanceTimersByTimeAsync(1000); const reconnected = sockets.at(-1)!; reconnected.emit("open");
    reconnected.emit("message", Buffer.from(JSON.stringify(trade())));
    expect(f.fills()).toHaveLength(1); expect(f.client.evidenceState()).toMatchObject({ connectionEpoch: 2, complete: false });
  });
  it("persists idempotent confirmation history across a local reconciler restart without backfill", async () => {
    const f = await fixture(); f.send(trade()); f.client.close(); const before = f.fills();
    const next = await fixture(f.db); next.send(trade());
    expect(next.fills()).toEqual(before); expect(next.client.evidenceState().sessionId).not.toBe(f.client.evidenceState().sessionId);
    expect(next.client.evidenceState().complete).toBe(false);
  });
  it("blocks delayed callbacks after close so the caller can close its database safely", async () => {
    const f = await fixture(); f.client.close(); const before = f.receipts().length;
    f.send(trade()); f.socket.emit("open");
    expect(f.receipts()).toHaveLength(before); expect(f.fills()).toHaveLength(0);
    expect(f.client.evidenceState().connected).toBe(false);
  });
  it("does not release the unconfirmed remainder on an order-only FILLED notification", async () => {
    const f = await fixture(); f.send({ event_type: "order", id: "take", status: "FILLED", size_matched: "10" });
    expect(f.row()).toMatchObject({ status: "OPEN", filled_size: 0 });
    expect(f.row().size - f.row().filled_size).toBe(10); expect(f.fills()).toHaveLength(0);
    f.send(trade({ size: "10" })); expect(f.row()).toMatchObject({ status: "FILLED", filled_size: 10 });
    f.send({ event_type: "order", id: "take", status: "OPEN", size_matched: "0" });
    expect(f.row()).toMatchObject({ status: "FILLED", filled_size: 10 });
  });
  it("computes confirmed VWAP across identified partials without overwriting it from an order limit price", async () => {
    const f = await fixture(); f.send(trade()); f.send(trade({ id: "trade-2", size: "3", price: "0.44" }));
    expect(f.row()).toMatchObject({ status: "PARTIAL", filled_size: 5 }); expect(f.row().filled_price).toBeCloseTo(.416, 12);
    f.send({ event_type: "order", id: "take", status: "LIVE", price: "0.7", size_matched: "9" });
    expect(f.row().filled_price).toBeCloseTo(.416, 12); expect(f.row().size - f.row().filled_size).toBe(5);
  });
  it("rejects ambiguous original order IDs rather than attributing a fill to the first matching row", async () => {
    const f = await fixture();
    f.db.prepare("INSERT INTO shadow_orders VALUES(3,'take','A','BUY','OPEN',10,0,NULL,0)").run();
    f.send(trade()); expect(f.fills()).toHaveLength(0);
    expect(f.receipts().at(-1).projection_error).toContain("ambiguous_external_order");
  });
  it("accepts the official Rust SDK full-trade fixture without inventing sides for unowned counterparties", async () => {
    // Polymarket/rs-clob-client dc8f1e58eb1e504dcb3d45a94a647dd2da89912b,
    // benches/deserialize_websocket.rs trade_full: maker entries have no side.
    const f = await fixture();
    f.db.prepare("UPDATE shadow_orders SET external_order_id='0xabcdef',token_id='123456789',size=25 WHERE id=1").run();
    const owner = "550e8400-e29b-41d4-a716-446655440000";
    const payload = { id: "trade_123", market: "0x" + "0".repeat(63) + "1", asset_id: "123456789", side: "BUY",
      size: "25.0", price: "0.55", status: "CONFIRMED", type: "TRADE", last_update: "1704110400000",
      matchtime: "1704110400000", timestamp: "1704110400000", outcome: "Yes", owner, trade_owner: owner,
      taker_order_id: "0xabcdef", fee_rate_bps: "25", transaction_hash: "0x" + "0".repeat(61) + "abc", trader_side: "TAKER",
      maker_orders: [{ order_id: "0x111", asset_id: "123456789", outcome: "Yes", price: "0.55", matched_amount: "10.0", owner },
        { order_id: "0x222", asset_id: "123456789", outcome: "Yes", price: "0.55", matched_amount: "15.0", owner }] };
    f.send({ event_type: "trade", data: payload });
    expect(f.fills()).toHaveLength(1); expect(f.row()).toMatchObject({ status: "FILLED", filled_size: 25, filled_price: .55 });
    expect(JSON.parse(f.receipts().at(-1).payload_json)).toEqual(payload);
  });
  it.each(["bound", "wrong_token", "ambiguous", "contradictory_side"])("handles missing maker side using only the %s original local binding", async kind => {
    const f = await fixture();
    if (kind === "ambiguous") f.db.prepare("INSERT INTO shadow_orders VALUES(3,'make','B','SELL','OPEN',10,0,NULL,0)").run();
    const maker: any = { order_id: "make", asset_id: kind === "wrong_token" ? "A" : "B", price: "0.62", matched_amount: "3" };
    if (kind === "contradictory_side") maker.side = "BUY";
    f.send(trade({ taker_order_id: "unowned-taker", maker_orders: [maker] }));
    expect(f.fills()).toHaveLength(kind === "bound" ? 1 : 0);
    if (kind === "bound") expect(f.row(2)).toMatchObject({ filled_size: 3, filled_price: .62 });
    else expect(f.receipts().at(-1).projection_status).toBe("REJECTED");
  });
  it("accepts documented statusless CANCELLATION and preserves nullable legacy status as OPEN", async () => {
    const f = await fixture(); f.db.prepare("UPDATE shadow_orders SET status=NULL WHERE id=1").run();
    f.send(trade()); expect(f.row()).toMatchObject({ status: "PARTIAL", filled_size: 2 });
    f.send({ event_type: "order", type: "CANCELLATION", id: "take", size_matched: "2" });
    expect(f.row()).toMatchObject({ status: "CANCELLED", filled_size: 2 });
  });
  it("does not reinterpret unknown status or a contradictory cancellation as a valid local state", async () => {
    const f = await fixture(); f.db.prepare("UPDATE shadow_orders SET status='UNKNOWN' WHERE id=1").run();
    f.send(trade()); expect(f.fills()).toHaveLength(0);
    f.db.prepare("UPDATE shadow_orders SET status='OPEN' WHERE id=1").run();
    f.send({ event_type: "order", type: "CANCELLATION", id: "take", status: "LIVE" });
    expect(f.row().status).toBe("OPEN"); expect(f.receipts().at(-1).projection_status).toBe("REJECTED");
  });
  it("retains an identified FAILED header even without allocation fields and quarantines later CONFIRMED", async () => {
    const f = await fixture(); f.send({ event_type: "trade", id: "trade-1", status: "FAILED" });
    expect(f.receipts().at(-1)).toMatchObject({ trade_header_valid: 1, projection_status: "FAILED_RECORDED" });
    f.send(trade()); expect(f.fills()).toHaveLength(0);
    expect(f.receipts().at(-1).projection_error).toContain("conflicting_terminal_trade");
  });
  it("rejects changed known pending identities but allows consistent missing-field enrichment", async () => {
    const f = await fixture(); f.send({ event_type: "trade", id: "trade-1", status: "MATCHED", taker_order_id: "take", asset_id: "B" });
    f.send(trade()); expect(f.fills()).toHaveLength(0);
    expect(f.receipts().at(-1).projection_error).toContain("conflicting_trade_identity");
    f.send({ event_type: "trade", id: "trade-2", status: "MATCHED", taker_order_id: "take", asset_id: "A" });
    f.send(trade({ id: "trade-2" })); expect(f.fills()).toHaveLength(1);
  });
  it("preserves rejected terminal identity evidence while accepting only consistent later enrichment", async () => {
    const f = await fixture(); f.send(trade({ asset_id: "B" }));
    expect(f.receipts().at(-1)).toMatchObject({ trade_header_valid: 1, projection_status: "REJECTED" });
    f.send(trade()); expect(f.fills()).toHaveLength(0);
    f.send({ event_type: "trade", id: "trade-2", status: "CONFIRMED", taker_order_id: "take", asset_id: "A" });
    f.send(trade({ id: "trade-2" })); expect(f.fills()).toHaveLength(1);
  });
  it("treats a nonfinal update after terminal evidence as audit-only, without poisoning later duplicates", async () => {
    const f = await fixture(); f.send(trade()); const before = f.fills();
    f.send(trade({ status: "MATCHED", asset_id: "B" }));
    expect(f.receipts().at(-1).projection_status).toBe("NONFINAL_AFTER_TERMINAL");
    f.send(trade()); expect(f.fills()).toEqual(before); expect(f.receipts().at(-1).projection_status).toBe("CONFIRMED_RECORDED");
  });
  it("retains confirmation before local order insertion as deferred without claiming complete inventory", async () => {
    const f = await fixture(); f.db.prepare("DELETE FROM shadow_orders WHERE id=1").run(); f.send(trade());
    expect(f.fills()).toHaveLength(0); expect(f.receipts().at(-1).projection_status).toBe("CONFIRMED_UNOWNED_DEFERRED");
    f.db.prepare("INSERT INTO shadow_orders VALUES(1,'take','A','BUY','OPEN',10,0,NULL,0)").run();
    expect(f.fills()).toHaveLength(0); expect(f.client.evidenceState().complete).toBe(false);
    // An actual repeated source message can reconcile idempotently; no source event
    // or historical receipt is manufactured just because a local order appeared.
    f.send(trade()); expect(f.fills()).toHaveLength(1);
  });
  it.each(["append", "elide", "empty_to_populated"])("does not %s a complete confirmed maker allocation set", async kind => {
    const f = await fixture();
    const maker = { order_id: "make", asset_id: "B", side: "SELL", price: "0.62", matched_amount: "3" };
    f.send(trade({ maker_orders: kind === "empty_to_populated" ? [] : [maker] })); const before = f.fills();
    const next: any = trade({ maker_orders: kind === "append" ? [maker, { ...maker, order_id: "new-order" }]
      : kind === "empty_to_populated" ? [maker] : undefined });
    f.send(next); expect(f.fills()).toEqual(before);
    expect(f.receipts().at(-1).projection_error).toContain("conflicting_duplicate_trade");
  });
  it("cannot project a fill if atomic terminal-header receipt insertion fails", async () => {
    const f = await fixture();
    f.db.exec(`CREATE TRIGGER fail_header BEFORE INSERT ON user_ws_receipts
      WHEN NEW.kind='trade' AND NEW.trade_header_valid=1 BEGIN SELECT RAISE(ABORT,'header-write-failed'); END;`);
    expect(() => f.send(trade())).toThrow("header-write-failed");
    expect(f.fills()).toHaveLength(0); expect(f.row().filled_size).toBe(0);
  });
  it("accepts the SDK's lowercase cancellation subtype without reopening inventory", async () => {
    const f = await fixture(); f.send({ event_type: "order", type: "cancellation", id: "take" });
    expect(f.row()).toMatchObject({ status: "CANCELLED", filled_size: 0 }); expect(f.fills()).toHaveLength(0);
  });
  it("quarantines differing explicit confirmed transaction hashes while allowing pending retries to change hashes", async () => {
    const f = await fixture();
    f.send(trade({ status: "MATCHED", transaction_hash: "0x" + "1".repeat(64) }));
    f.send(trade({ status: "RETRYING", transaction_hash: "0x" + "2".repeat(64) }));
    f.send(trade({ transaction_hash: "0x" + "3".repeat(64) })); const before = f.fills();
    expect(before).toHaveLength(1);
    f.send(trade({ transaction_hash: "0x" + "4".repeat(64) })); expect(f.fills()).toEqual(before);
    expect(f.receipts().at(-1).projection_error).toContain("conflicting_confirmation_transaction");
  });
});
