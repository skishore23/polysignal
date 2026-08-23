import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { TakerLoop } from "../../apps/worker/src/taker/TakerLoop";

const createSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE market_events (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE markets (
      id TEXT PRIMARY KEY,
      event_id TEXT,
      question TEXT,
      slug TEXT,
      active INTEGER,
      volume REAL,
      liquidity REAL,
      taker_base_fee REAL
    );
    CREATE TABLE tokens (id TEXT PRIMARY KEY, market_id TEXT, fee_rate_bps INTEGER);
    CREATE TABLE latest_features (
      token_id TEXT,
      market_id TEXT,
      ts INTEGER,
      mid REAL,
      spread REAL,
      best_bid REAL,
      best_ask REAL,
      bid_depth_top REAL,
      ask_depth_top REAL,
      obi REAL,
      vol30m REAL,
      microprice_minus_mid REAL
    );
    CREATE TABLE wallets (
      id INTEGER PRIMARY KEY,
      auto_trade_enabled INTEGER,
      maker_enabled INTEGER,
      size_multiplier REAL,
      taker_side TEXT,
      market_filter_json TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE clob_events (
      global_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      recv_ts_ms INTEGER,
      conn_id TEXT,
      token_id TEXT,
      msg_type TEXT,
      payload_json TEXT
    );
    CREATE TABLE shadow_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      wallet_id INTEGER,
      token_id TEXT,
      market_id TEXT,
      side TEXT,
      kind TEXT,
      price REAL,
      size REAL,
      expected_cancel_ts INTEGER,
      execution_mode TEXT,
      source TEXT,
      client_order_id TEXT,
      external_order_id TEXT,
      status TEXT,
      filled_size REAL,
      filled_price REAL,
      last_update_ts INTEGER,
      strategy_lane TEXT,
      decision_group_id TEXT,
      pred_source TEXT,
      pred_edge_bps REAL,
      spread_bps REAL,
      fees_bps REAL,
      expected_slippage_bps REAL,
      expected_adverse_bps REAL,
      expected_queue_bps REAL,
      cost_bps REAL,
      net_edge_bps REAL,
      decision TEXT,
      decision_reason TEXT,
      mid_px REAL,
      spread_px REAL,
      bid_px REAL,
      ask_px REAL,
      bid_depth REAL,
      ask_depth REAL,
      prior_p_hat REAL
    );
    CREATE TABLE shadow_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      order_id INTEGER,
      price REAL,
      size REAL,
      method TEXT
    );
    CREATE TABLE decision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      token_id TEXT,
      wallet_id INTEGER,
      kind TEXT,
      strategy_lane TEXT,
      decision_group_id TEXT,
      decision TEXT,
      decision_reason TEXT,
      pred_edge_bps REAL,
      cost_bps REAL,
      net_edge_bps REAL,
      spread_bps REAL,
      fees_bps REAL,
      expected_slippage_bps REAL,
      mid_px REAL,
      spread_px REAL,
      delta_hat REAL,
      size REAL,
      bid_px REAL,
      ask_px REAL,
      bid_depth REAL,
      ask_depth REAL
    );
  `);
};

const seedBase = (db: Database.Database, now: number): void => {
  db.prepare("INSERT INTO market_events (id, title) VALUES ('e1', 'BTC Event')").run();
  db.prepare(
    `INSERT INTO markets (id, event_id, question, slug, active, volume, liquidity, taker_base_fee)
     VALUES ('m1', 'e1', 'Will BTC be up in 5 minutes?', 'btc-5m', 1, 1000, 1000, 0.1)`
  ).run();
  db.prepare("INSERT INTO tokens (id, market_id, fee_rate_bps) VALUES ('t1', 'm1', 2500)").run();
  db.prepare(
    `INSERT INTO latest_features
     (token_id, market_id, ts, mid, spread, best_bid, best_ask, bid_depth_top, ask_depth_top, obi, vol30m, microprice_minus_mid)
     VALUES ('t1', 'm1', ?, 0.5, 0.01, 0.495, 0.505, 100, 100, 0, 0.01, 0.0003)`
  ).run(now);
  db.prepare(
    `INSERT INTO wallets (id, auto_trade_enabled, maker_enabled, size_multiplier, taker_side, market_filter_json)
     VALUES (1, 1, 0, 1, 'BOTH', NULL)`
  ).run();
};

const seedTradeBurst = (db: Database.Database, now: number): void => {
  const insert = db.prepare(
    `INSERT INTO clob_events (recv_ts_ms, conn_id, token_id, msg_type, payload_json)
     VALUES (?, 'test', 't1', 'trade', ?)`
  );
  insert.run(now - 20_000, JSON.stringify({ side: "BUY", price: 0.6, size: 30 }));
  insert.run(now - 10_000, JSON.stringify({ side: "BUY", price: 0.62, size: 20 }));
  insert.run(now - 5_000, JSON.stringify({ side: "BUY", price: 0.625, size: 25 }));
};

const buildLoop = (db: Database.Database, toxicityEnabled: boolean): TakerLoop =>
  new TakerLoop(
    {
      enabled: true,
      intervalMs: 10_000,
      baseOrderSize: 20,
      maxNotionalPerOrderUsd: 100,
      minNetEdgeBps: -1_000,
      maxLongPerToken: 1000,
      maxShortPerToken: 1000,
      maxSpread: 0.05,
      minDepth: 1,
      slippageBps: 1,
      adverseSelectionBps: 1,
      queueLossBps: 1,
      inventoryPenaltyBps: 0,
      orderTtlMs: 5_000,
      marketScope: "ALL",
      executionMode: "PAPER",
      close: {
        enabled: false,
        maxHoldSec: 900,
        closeMinEdgeToHoldBps: 0.5,
        edgeBelowTicks: 3,
        edgeBelowMs: 30_000,
        closeCooldownSec: 20
      },
      toxicity: {
        enabled: toxicityEnabled,
        lookbackSec: 30,
        minTradeEvents: 2,
        shockBps: 5,
        dominantSideRatio: 0.7,
        micropriceShockBps: 2,
        cooldownMs: 20_000
      },
      maxFeatureStalenessSec: 120
    },
    {
      sqlite: db,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        trace: () => {},
        fatal: () => {}
      } as any,
      belief: {
        estimate: async () => ({ source: "test", probability: 0.7 })
      } as any
    }
  );

describe("Taker toxicity gate", () => {
  it("blocks new taker opens during a one-sided shock burst", async () => {
    const db = new Database(":memory:");
    const now = Date.now();
    createSchema(db);
    seedBase(db, now);
    seedTradeBurst(db, now);

    const loop = buildLoop(db, true);
    await (loop as any).tick();

    const submitCount = (
      db.prepare("SELECT COUNT(*) as c FROM shadow_orders WHERE kind IN ('TAKER_BUY','TAKER_SELL')").get() as {
        c: number;
      }
    ).c;
    const toxicitySkips = (
      db.prepare(
        "SELECT COUNT(*) as c FROM decision_log WHERE decision = 'SKIP' AND decision_reason LIKE 'toxicity_gate:%'"
      ).get() as { c: number }
    ).c;

    expect(submitCount).toBe(0);
    expect(toxicitySkips).toBeGreaterThan(0);
    db.close();
  });

  it("allows taker opens when toxicity gate is disabled", async () => {
    const db = new Database(":memory:");
    const now = Date.now();
    createSchema(db);
    seedBase(db, now);
    seedTradeBurst(db, now);

    const loop = buildLoop(db, false);
    await (loop as any).tick();

    const submitCount = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM shadow_orders WHERE kind IN ('TAKER_BUY','TAKER_SELL') AND decision = 'SUBMIT'"
        )
        .get() as { c: number }
    ).c;

    expect(submitCount).toBeGreaterThan(0);
    db.close();
  });
});
