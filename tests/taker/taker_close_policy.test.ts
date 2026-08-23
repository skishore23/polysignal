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
      method TEXT,
      note TEXT
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

const seedBase = (db: Database.Database, featureTs: number): void => {
  db.prepare("INSERT INTO market_events (id, title) VALUES ('e1', 'BTC Event')").run();
  db.prepare(
    `INSERT INTO markets (id, event_id, question, slug, active, volume, liquidity, taker_base_fee)
     VALUES ('m1', 'e1', 'Will BTC be up in 5 minutes?', 'btc-5m', 1, 1000, 1000, 0.1)`
  ).run();
  db.prepare("INSERT INTO tokens (id, market_id, fee_rate_bps) VALUES ('t1', 'm1', 2500)").run();
  db.prepare(
    `INSERT INTO latest_features
     (token_id, market_id, ts, mid, spread, best_bid, best_ask, bid_depth_top, ask_depth_top, obi, vol30m, microprice_minus_mid)
     VALUES ('t1', 'm1', ?, 0.5, 0.01, 0.495, 0.505, 100, 100, 0, 0.01, 0)`
  ).run(featureTs);
  db.prepare(
    `INSERT INTO wallets (id, auto_trade_enabled, maker_enabled, size_multiplier, taker_side, market_filter_json)
     VALUES (1, 1, 0, 1, 'BOTH', NULL)`
  ).run();
};

const makeLoop = (db: Database.Database, closeCfg: Partial<{
  maxHoldSec: number;
  closeMinEdgeToHoldBps: number;
  edgeBelowTicks: number;
  edgeBelowMs: number;
}>, beliefProbability = 0.5): TakerLoop =>
  new TakerLoop(
    {
      enabled: true,
      intervalMs: 10_000,
      baseOrderSize: 20,
      maxNotionalPerOrderUsd: 100,
      minNetEdgeBps: 10_000,
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
        enabled: true,
        maxHoldSec: closeCfg.maxHoldSec ?? 900,
        closeMinEdgeToHoldBps: closeCfg.closeMinEdgeToHoldBps ?? 0.5,
        edgeBelowTicks: closeCfg.edgeBelowTicks ?? 3,
        edgeBelowMs: closeCfg.edgeBelowMs ?? 30_000,
        closeCooldownSec: 0
      },
      maxFeatureStalenessSec: 60
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
        estimate: async () => ({ source: "test", probability: beliefProbability })
      } as any
    }
  );

const seedOpenLong = (db: Database.Database, fillTs: number): void => {
  db.prepare(
    `INSERT INTO shadow_orders
     (id, ts, wallet_id, token_id, market_id, side, kind, price, size, execution_mode, status)
     VALUES (1, ?, 1, 't1', 'm1', 'BUY', 'TAKER_BUY', 0.52, 10, 'SHADOW', 'FILLED')`
  ).run(fillTs);
  db.prepare(
    `INSERT INTO shadow_fills (ts, order_id, price, size, method, note)
     VALUES (?, 1, 0.52, 10, 'taker_immediate', 'seed')`
  ).run(fillTs);
};

describe("Taker close policy", () => {
  it("submits close:max_hold when hold time exceeds threshold", async () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedBase(db, Date.now());
    seedOpenLong(db, Date.now() - 20_000);

    const loop = makeLoop(db, { maxHoldSec: 1, closeMinEdgeToHoldBps: -9999 });
    await (loop as any).tick();

    const closeOrders = db
      .prepare("SELECT COUNT(*) as c FROM shadow_orders WHERE decision_reason LIKE 'close:max_hold%'")
      .get() as { c: number };
    expect(closeOrders.c).toBeGreaterThan(0);
    db.close();
  });

  it("triggers edge-decay close after hysteresis thresholds", async () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedBase(db, Date.now());
    seedOpenLong(db, Date.now() - 1_000);

    const loop = makeLoop(db, {
      maxHoldSec: 100_000,
      closeMinEdgeToHoldBps: 1_000,
      edgeBelowTicks: 2,
      edgeBelowMs: 60_000
    }, 0.01);
    await (loop as any).tick();
    await (loop as any).tick();

    const closeOrders = db
      .prepare("SELECT COUNT(*) as c FROM shadow_orders WHERE decision_reason LIKE 'close:edge_decay%'")
      .get() as { c: number };
    expect(closeOrders.c).toBeGreaterThan(0);
    db.close();
  });

  it("does not edge-decay close when close edge is negative", async () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedBase(db, Date.now());
    seedOpenLong(db, Date.now() - 1_000);

    const loop = makeLoop(
      db,
      {
        maxHoldSec: 100_000,
        closeMinEdgeToHoldBps: 1_000,
        edgeBelowTicks: 1,
        edgeBelowMs: 1
      },
      0.5
    );
    await (loop as any).tick();
    await (loop as any).tick();

    const closeOrders = db
      .prepare("SELECT COUNT(*) as c FROM shadow_orders WHERE decision_reason LIKE 'close:edge_decay%'")
      .get() as { c: number };
    expect(closeOrders.c).toBe(0);
    db.close();
  });

  it("does not edge-decay close when hold edge stays above threshold", async () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedBase(db, Date.now());
    seedOpenLong(db, Date.now() - 1_000);

    const loop = makeLoop(
      db,
      {
        maxHoldSec: 100_000,
        closeMinEdgeToHoldBps: 1_000,
        edgeBelowTicks: 1,
        edgeBelowMs: 1
      },
      0.99
    );
    await (loop as any).tick();
    await (loop as any).tick();

    const closeOrders = db
      .prepare("SELECT COUNT(*) as c FROM shadow_orders WHERE decision_reason LIKE 'close:edge_decay%'")
      .get() as { c: number };
    expect(closeOrders.c).toBe(0);
    db.close();
  });
});
