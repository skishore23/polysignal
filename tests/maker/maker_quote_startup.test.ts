import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { newOfflineDatabase, installStartupSink, oneOfflineMakerTick, type StartupContract } from "../../scripts/research/maker_quote_startup";

const schema = readFileSync("tests/maker/fixtures/startup-canonical-schema.sql", "utf8");
const bindings: Record<string, string> = {
  "tests/maker/fixtures/startup-canonical-schema.sql": "8427e7813954d8ef552ac0ca265d55137b0edf9aa914f0afd606a5a6d92fc844",
  "configs/worker.json": "35f3c50a33a2e1b2552c8ea1d6d30c0851833d76b50ceaa3c085ea36728c6fc0",
  "data/markov_regime.json": "aa3b9a7f6f0ef665a494f7ca23ea5de0bc767fd3b91de387cebca49bc0af61a5",
  "data/strategy_regime_report.json": "b936f84149682ec9359b391bd66496291e69a214f55be64c6fd7f57d277600fd",
  "data/regime_manifest.json": "6eae7fc26d17f2fc4b20d04e19dbd62c4c30da3c9ed88274272c6059e6e2dc9a"
};
const databases: Database.Database[] = [];
afterEach(() => { for (const d of databases.splice(0)) d.close(); vi.restoreAllMocks(); });
const clock = { utc: 1_800_000_000_000, mono: 12345 };
function fixture(change: (c: StartupContract) => void = () => {}) {
  const dir = mkdtempSync(path.resolve("reports/evidence/startup-offline-197-"));
  const file = path.join(dir, "paper.sqlite");
  const db = newOfflineDatabase(file, schema); databases.push(db);
  const c: StartupContract = { purpose: "SYNTHETIC_OFFLINE_ENGINEERING", market: "fixture-market", condition: "fixture-condition",
    wallet: 1, tokens: ["fixture-yes", "fixture-no"], book: { token: "fixture-yes", bid: "0.49", ask: "0.51",
      tick: "0.01", lot: "0.01", minimum: "1", receipt: { ...clock }, venueUtc: clock.utc,
      valid: true, sourceHash: "a".repeat(64) }, fee: { perShareUSDC: "0", provenance: "explicit synthetic zero fee bound, not observed" } };
  change(c);
  let current = { ...clock };
  const sink = installStartupSink(db, c, () => ({ ...current }));
  return { db, sink, dir, file, c, setClock: (x: typeof clock) => { current = x; } };
}
const order = (id = "q1", change: Record<string, unknown> = {}) => ({
  ts: clock.utc, wallet_id: 1, token_id: "fixture-yes", market_id: "fixture-market", side: "BUY", kind: "MAKER_BID",
  price: 0.5, size: 2, expected_cancel_ts: clock.utc + 5000, execution_mode: "SHADOW", source: "maker_loop",
  client_order_id: id, decision_group_id: id, external_order_id: null, status: "OPEN", filled_size: 0, filled_price: null,
  last_update_ts: clock.utc, strategy_lane: "MAKER", decision: "SUBMIT", ...change
});
function submit(db: Database.Database, o = order(), breakDecision = false) {
  const keys = Object.keys(o);
  db.transaction(() => {
    db.prepare(`INSERT INTO shadow_orders (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(o));
    db.prepare(`INSERT INTO decision_log(ts,token_id,wallet_id,kind,strategy_lane,decision_group_id,decision,size)
      VALUES (?,?,?,?,?,?,?,?)`).run(o.ts, o.token_id, o.wallet_id, o.kind, o.strategy_lane,
      breakDecision ? "orphan" : o.decision_group_id, "SUBMIT", o.size);
  })();
}
function seed(db: Database.Database) {
  db.prepare("INSERT INTO market_events(id,title,created_at,updated_at) VALUES (?,?,?,?)").run("event", "BTC fixture", clock.utc, clock.utc);
  db.prepare(`INSERT INTO markets(id,event_id,condition_id,question,slug,updated_at,created_at,minimum_tick_size,minimum_order_size,taker_base_fee)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("fixture-market", "event", "fixture-condition", "BTC up or down 5 minute fixture", "btc-updown-5m-fixture", clock.utc, clock.utc, .01, 1, .1);
  db.prepare("INSERT INTO tokens(id,market_id,outcome,updated_at,fee_rate_bps) VALUES (?,?,?,?,?)").run("fixture-yes", "fixture-market", "Yes", clock.utc, 2500);
  db.prepare(`INSERT INTO wallets(id,name,starting_balance,created_at,maker_enabled,auto_trade_enabled,maker_inventory_max_abs)
    VALUES (1,'Synthetic offline only',10,?,1,0,50)`).run(clock.utc);
  db.prepare(`INSERT INTO latest_features(token_id,market_id,ts,mid,spread,best_bid,best_ask,bid_depth_top,ask_depth_top,obi,vol30m,microprice_minus_mid)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("fixture-yes", "fixture-market", clock.utc, .5, .02, .49, .51, 100, 100, .8, .01, 0);
  db.prepare("INSERT INTO clob_events(recv_ts_ms,conn_id,token_id,msg_type,payload_json) VALUES (?,?,?,?,?)")
    .run(clock.utc, "synthetic", "fixture-yes", "trade", "{}");
}

describe("isolated no-fill maker startup boundary", () => {
  it("pins canonical table DDL and existing ordinary configuration/model data", () => {
    for (const [file, digest] of Object.entries(bindings)) expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(digest);
  });
  it("requires a new exclusive report DB and installed guard", async () => {
    const f = fixture(); expect(() => newOfflineDatabase(f.file, schema)).toThrow();
    expect(() => newOfflineDatabase(path.resolve("data/must-not-exist.sqlite"), schema)).toThrow();
    const memory = new Database(":memory:"); databases.push(memory);
    expect(() => installStartupSink(memory, f.c, () => clock)).toThrow();
    await expect(oneOfflineMakerTick(memory, {}, {})).rejects.toThrow("installed_sink_required");
  });
  it("accepts a valid BUY once; rejects duplicate and rolls back orphan decision atomically", () => {
    const f = fixture(); submit(f.db);
    expect(() => submit(f.db)).toThrow();
    expect(() => submit(f.db, order("q2", { size: 1 }), true)).toThrow();
    expect(f.sink.snapshot().orders).toHaveLength(1); expect(f.sink.snapshot().decisions).toHaveLength(1);
    expect(f.sink.snapshot().pendingLiabilityNumerator).toBe("1000000000000000000");
  });
  it.each([
    ["sell", { side: "SELL", kind: "MAKER_ASK" }], ["wrong token", { token_id: "fixture-no" }],
    ["wrong market", { market_id: "wrong" }], ["tick", { price: .499 }], ["lot", { size: 1.001 }],
    ["minimum", { size: .99 }], ["zero size", { size: 0 }], ["negative", { price: -1 }],
    ["null", { price: null }], ["boolean", { size: true }], ["blank", { size: " " }],
    ["infinity", { price: Infinity }], ["crossing", { price: .51 }], ["FULL", { execution_mode: "FULL" }],
    ["external", { external_order_id: "venue" }], ["filled", { filled_size: .1 }],
    ["filled price", { filled_price: .5 }], ["status", { status: "PARTIAL" }],
    ["nonmaker", { strategy_lane: "TAKER" }], ["cap", { size: 5 }], ["future order", { ts: clock.utc + 1 }]
  ])("rejects %s before persistence", (_name, changes) => {
    const f = fixture(); expect(() => submit(f.db, order("bad", changes))).toThrow();
    expect(f.sink.snapshot().orders).toHaveLength(0); expect(f.sink.snapshot().decisions).toHaveLength(0);
  });
  it.each(["stale", "backward", "futureReceipt", "venueFuture", "skew", "invalid", "crossed", "fee"])("rejects %s metadata/clock", (kind) => {
    const f = fixture(c => {
      if (kind === "futureReceipt") c.book.receipt.utc++;
      if (kind === "venueFuture") c.book.venueUtc++;
      if (kind === "invalid") c.book.valid = false;
      if (kind === "crossed") c.book.bid = ".52";
      if (kind === "fee") c.fee = null;
    });
    if (kind === "stale") f.setClock({ utc: clock.utc + 1001, mono: clock.mono + 1001 });
    if (kind === "backward") f.setClock({ utc: clock.utc - 1, mono: clock.mono - 1 });
    if (kind === "skew") f.setClock({ utc: clock.utc + 200, mono: clock.mono });
    expect(() => submit(f.db)).toThrow(); expect(f.sink.rejections).toHaveLength(1);
  });
  it("reserves nonzero fee liabilities across orders and releases only on terminal cancellation", () => {
    const f = fixture(c => { c.fee!.perShareUSDC = "0.01"; });
    submit(f.db); expect(() => submit(f.db, order("q2"))).toThrow();
    expect(f.sink.snapshot().pendingLiabilityNumerator).toBe("1020000000000000000");
    expect(() => f.db.prepare("UPDATE shadow_orders SET size=1,status='CANCELLED'").run()).toThrow();
    expect(() => f.db.prepare("DELETE FROM shadow_orders").run()).toThrow();
    expect(f.sink.cancelAll().syntheticCashUSDC).toBe("10");
    expect(f.sink.cancelAll().pendingLiabilityUSDC).toBe("0");
    submit(f.db, order("q3"));
    expect(() => f.db.prepare("UPDATE shadow_orders SET status='OPEN' WHERE client_order_id='q1'").run()).toThrow();
    f.sink.cancelAll();
  });
  it("prohibits every fill and retains immutable synthetic opening", () => {
    const f = fixture(); submit(f.db);
    expect(() => f.db.prepare("INSERT INTO shadow_fills(ts,order_id,price,size,method) VALUES (?,1,.5,1,'trade_match')").run(clock.utc)).toThrow();
    expect(() => f.db.exec("UPDATE startup_opening SET record='{}'")).toThrow();
    expect(() => f.db.exec("UPDATE decision_log SET decision='SKIP'")).toThrow();
    expect(() => f.db.exec("DELETE FROM decision_log")).toThrow();
    expect(f.sink.cancelAll()).toMatchObject({ syntheticCashUSDC: "10", fills: 0, profitUSDC: null });
  });
  it("does not expose mutable internal contract through snapshots or caller input", () => {
    const f = fixture(); f.c.book.lot = "0.001";
    f.sink.snapshot().contract.book.lot = "0.001";
    f.sink.snapshot().contract.fee!.perShareUSDC = "1";
    expect(() => submit(f.db, order("bad-lot", { size: 1.001 }))).toThrow();
    submit(f.db);
    expect(f.sink.snapshot().pendingLiabilityNumerator).toBe("1000000000000000000");
  });
  it("invokes actual MakerLoop with real belief and loaded pinned regime gate, without network/fills", async () => {
    const f = fixture(); seed(f.db);
    vi.spyOn(Date, "now").mockReturnValue(clock.utc);
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("network forbidden"); });
    const config = { ...JSON.parse(readFileSync("configs/worker.json", "utf8")), executionMode: "PAPER" };
    const logger = Object.fromEntries(["info", "warn", "error", "debug", "trace", "fatal"].map(k => [k, () => {}]));
    let gate: unknown, failure: unknown;
    try { gate = await oneOfflineMakerTick(f.db, config, logger); } catch (e) { failure = String(e); }
    const beforeCancel = f.sink.snapshot();
    const terminal = f.sink.cancelAll();
    writeFileSync(path.join(f.dir, "actual-engine.json"), JSON.stringify({ scope: "SYNTHETIC_OFFLINE_ONLY", bindings, gate,
      failure, rejections: f.sink.rejections, beforeCancel, afterCancel: f.sink.snapshot(), terminal }, null, 2));
    expect(network).not.toHaveBeenCalled();
    expect(failure).toBeUndefined();
    expect(gate).toMatchObject({ loaded: true });
    expect(beforeCancel.orders).toHaveLength(1);
    expect(beforeCancel.decisions.filter((d: any) => d.decision === "SUBMIT")).toHaveLength(1);
    expect(beforeCancel.fills).toHaveLength(0);
  });
});
