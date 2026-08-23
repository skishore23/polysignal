import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MakerLoop } from "../../apps/worker/src/maker/MakerLoop";

const createSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE market_events (
      id TEXT PRIMARY KEY,
      title TEXT
    );
    CREATE TABLE markets (
      id TEXT PRIMARY KEY,
      event_id TEXT,
      question TEXT,
      slug TEXT,
      active INTEGER,
      volume REAL,
      liquidity REAL,
      taker_base_fee REAL,
      minimum_tick_size REAL,
      rewards_min_size REAL,
      rewards_max_spread REAL,
      rewards_rates_json TEXT
    );
    CREATE TABLE tokens (
      id TEXT PRIMARY KEY,
      market_id TEXT,
      fee_rate_bps INTEGER
    );
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
      maker_enabled INTEGER,
      size_multiplier REAL,
      maker_inventory_target REAL,
      maker_inventory_max_abs REAL,
      market_filter_json TEXT
    );
    CREATE TABLE shadow_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      order_id INTEGER,
      price REAL,
      size REAL,
      method TEXT
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
      inventory_i_before REAL,
      inventory_i_after REAL,
      inventory_delta_abs REAL,
      inventory_penalty_bps REAL,
      prior_p_hat REAL
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
    CREATE TABLE clob_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT,
      recv_ts_ms INTEGER,
      msg_type TEXT
    );
  `);
};

const makeLoop = (db: Database.Database): MakerLoop =>
  new MakerLoop(
    {
      intervalMs: 10_000,
      enableBidQuotes: true,
      enableAskQuotes: true,
      quoteSize: 50,
      maxNotionalPerOrderUsd: 100,
      minExpectedEvBps: 0.1,
      maxInventoryAbs: 1000,
      inventoryLambdaBps: 0,
      quoteHalfSpreadBps: 8,
      maxSpread: 0.03,
      minDepth: 10,
      slippageBps: 1,
      adverseSelectionBps: 1,
      queueLossBps: 1,
      rebateBps: 0,
      rebateShareAssumption: 0,
      liquidityRewardBpsWhenScoring: 0,
      orderTtlMs: 5_000,
      priceToleranceBps: 10,
      marketScope: "ALL",
      executionMode: "PAPER",
      tradeFlowGate: {
        enabled: true,
        lookbackSec: 600,
        minTradeEvents: 2,
        mode: "PASSIVE_DECAY",
        staleCancelAgeSec: 45
      }
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
        estimate: async () => ({ source: "test", probability: 0.55 })
      } as any
    }
  );

const seedBaseData = (db: Database.Database): void => {
  const now = Date.now();
  db.prepare("INSERT INTO market_events (id, title) VALUES (?, ?)").run("e1", "BTC event");
  db.prepare(
    `INSERT INTO markets
     (id, event_id, question, slug, active, volume, liquidity, taker_base_fee, minimum_tick_size, rewards_min_size, rewards_max_spread, rewards_rates_json)
     VALUES (?, ?, ?, ?, 1, 1000, 1000, 0.1, 0.001, 1, 3, NULL)`
  ).run("m1", "e1", "Will BTC be up in 5 minutes?", "btc-5m");
  db.prepare("INSERT INTO tokens (id, market_id, fee_rate_bps) VALUES (?, ?, ?)").run("t1", "m1", 2500);
  db.prepare(
    `INSERT INTO latest_features
     (token_id, market_id, ts, mid, spread, best_bid, best_ask, bid_depth_top, ask_depth_top, obi, vol30m, microprice_minus_mid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("t1", "m1", now, 0.5, 0.01, 0.495, 0.505, 100, 100, 0.0, 0.01, 0.0);
  db.prepare(
    `INSERT INTO wallets (id, maker_enabled, size_multiplier, maker_inventory_target, maker_inventory_max_abs, market_filter_json)
     VALUES (1, 1, 1, 0, 500, NULL)`
  ).run();
};

describe("Maker trade-flow gate", () => {
  it("logs skip and blocks submissions when trade flow is below threshold", async () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedBaseData(db);
    const loop = makeLoop(db);

    await (loop as any).tick();

    const skipCount = (
      db.prepare("SELECT COUNT(*) as c FROM decision_log WHERE decision_reason = 'maker_flow_gate_no_trades'").get() as { c: number }
    ).c;
    const orderCount = (db.prepare("SELECT COUNT(*) as c FROM shadow_orders").get() as { c: number }).c;
    expect(skipCount).toBeGreaterThan(0);
    expect(orderCount).toBe(0);
    db.close();
  });

  it("cancels stale resting maker orders in passive decay mode", async () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedBaseData(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO shadow_orders
       (ts, wallet_id, token_id, market_id, side, kind, price, size, expected_cancel_ts, execution_mode, status)
       VALUES (?, 1, 't1', 'm1', 'BUY', 'MAKER_BID', 0.49, 10, ?, 'SHADOW', 'OPEN')`
    ).run(now - 120_000, now + 30_000);

    const loop = makeLoop(db);
    await (loop as any).tick();

    const row = db.prepare("SELECT status FROM shadow_orders WHERE id = 1").get() as { status: string };
    const cancelLogCount = (
      db.prepare("SELECT COUNT(*) as c FROM decision_log WHERE decision_reason = 'maker_flow_gate_passive_decay_cancel'").get() as { c: number }
    ).c;
    expect(row.status).toBe("CANCELLED");
    expect(cancelLogCount).toBeGreaterThan(0);
    db.close();
  });

  it("treats same-market trade activity as eligible flow", async () => {
    const db = new Database(":memory:");
    createSchema(db);
    seedBaseData(db);
    const now = Date.now();
    db.prepare("INSERT INTO tokens (id, market_id, fee_rate_bps) VALUES (?, ?, ?)").run("t2", "m1", 2500);
    db.prepare("INSERT INTO clob_events (token_id, recv_ts_ms, msg_type) VALUES (?, ?, 'trade')").run("t2", now - 1_000);
    db.prepare("INSERT INTO clob_events (token_id, recv_ts_ms, msg_type) VALUES (?, ?, 'trade')").run("t2", now - 2_000);

    const loop = makeLoop(db);
    await (loop as any).tick();

    const flowSkipCount = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM decision_log WHERE token_id = 't1' AND decision_reason = 'maker_flow_gate_no_trades'"
        )
        .get() as { c: number }
    ).c;
    expect(flowSkipCount).toBe(0);
    db.close();
  });
});
