import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { MakerLoop } from "../../apps/worker/src/maker/MakerLoop";
import type { MakerParams } from "../../packages/types/src/maker";

const createSchema = (db: Database.Database) => {
  db.exec(`
    CREATE TABLE markets (
      id TEXT PRIMARY KEY,
      condition_id TEXT,
      volume REAL,
      liquidity REAL,
      active INTEGER,
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
      token_id TEXT NOT NULL,
      market_id TEXT,
      ts INTEGER NOT NULL,
      mid REAL,
      spread REAL,
      best_bid REAL,
      best_ask REAL,
      bid_depth_top REAL,
      ask_depth_top REAL,
      obi REAL,
      microprice_minus_mid REAL,
      staleness_sec REAL,
      entropy_30m REAL,
      vol30m REAL
    );

    CREATE TABLE wallets (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      starting_balance REAL NOT NULL,
      size_multiplier REAL NOT NULL,
      maker_enabled INTEGER NOT NULL,
      maker_quote_size REAL NOT NULL,
      maker_quote_width_bps REAL NOT NULL,
      maker_min_spread_bps REAL,
      maker_min_spread REAL NOT NULL,
      maker_max_spread REAL NOT NULL,
      maker_min_depth REAL NOT NULL,
      maker_max_entropy REAL,
      maker_max_vol REAL,
      maker_inventory_target REAL NOT NULL,
      maker_inventory_max_abs REAL NOT NULL,
      maker_inventory_band REAL NOT NULL,
      maker_inventory_skew_bps REAL NOT NULL,
      maker_inventory_skew_size REAL NOT NULL,
      maker_inventory_skew_bps_cap REAL,
      maker_quote_improve_fraction REAL,
      max_daily_loss_usd REAL,
      max_drawdown_pct REAL,
      cooldown_minutes INTEGER,
      market_allowlist TEXT,
      market_filter_json TEXT
    );

    CREATE TABLE shadow_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      price REAL,
      size REAL,
      method TEXT,
      note TEXT
    );

    CREATE TABLE shadow_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      wallet_id INTEGER,
      token_id TEXT NOT NULL,
      market_id TEXT,
      side TEXT NOT NULL,
      kind TEXT NOT NULL,
      price REAL,
      size REAL,
      expected_cancel_ts INTEGER,
      execution_mode TEXT NOT NULL,
      book_snapshot_json TEXT,
      source TEXT,
      client_order_id TEXT,
      external_order_id TEXT,
      status TEXT,
      filled_size REAL,
      filled_price REAL,
      last_update_ts INTEGER,
      state_id INTEGER,
      pred_edge_bps REAL,
      pred_source TEXT,
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
      delta_hat REAL,
      bid_px REAL,
      ask_px REAL,
      bid_depth REAL,
      ask_depth REAL,
      inventory_i_before REAL,
      inventory_i_after REAL,
      inventory_delta_abs REAL,
      inventory_penalty_bps REAL,
      net_edge_after_inventory_bps REAL
    );

    CREATE TABLE decision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      wallet_id INTEGER,
      kind TEXT NOT NULL,
      decision TEXT NOT NULL,
      decision_reason TEXT,
      pred_edge_bps REAL,
      cost_bps REAL,
      net_edge_bps REAL,
      spread_bps REAL,
      fees_bps REAL,
      expected_slippage_bps REAL,
      mid_px REAL,
      spread_px REAL,
      bid_px REAL,
      ask_px REAL,
      bid_depth REAL,
      ask_depth REAL
    );

    CREATE TABLE clob_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      recv_ts_ms INTEGER NOT NULL,
      msg_type TEXT NOT NULL
    );

    CREATE TABLE shadow_maker_metrics_latest (
      wallet_id INTEGER PRIMARY KEY,
      total_realized REAL,
      total_unrealized REAL
    );

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
};

const baseParams: MakerParams = {
  minSpreadBps: null,
  minSpread: 0.002,
  maxSpread: 0.02,
  minDepth: 10,
  maxEntropy: null,
  maxVol: null,
  baseQuoteSize: 50,
  quoteWidthBps: 20,
  inventoryTarget: 0,
  inventoryMaxAbs: 500,
  inventoryBand: 200,
  inventorySkewBps: 15,
  inventorySkewSize: 0.5,
  inventorySkewBpsCap: null,
  inventoryLambdaBps: 5,
  baseVol: 0.01,
  maxVolMultiplier: 3,
  quoteImproveFraction: 0
};

describe.skip("MakerLoop idle trace", () => {
  it("emits fresh-idle reason when regime blocks both sides", async () => {
    const db = new Database(":memory:");
    createSchema(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO markets (id, condition_id, rewards_min_size, rewards_max_spread, rewards_rates_json)
       VALUES ('m1', NULL, NULL, NULL, NULL)`
    ).run();
    db.prepare("INSERT INTO tokens (id, market_id, fee_rate_bps) VALUES ('t1', 'm1', NULL)").run();
    db.prepare(
      `INSERT INTO latest_features
       (token_id, market_id, ts, mid, spread, best_bid, best_ask, bid_depth_top, ask_depth_top, obi, microprice_minus_mid, staleness_sec, entropy_30m, vol30m)
       VALUES ('t1', 'm1', ?, 0.5, 0.01, 0.495, 0.505, 40, 40, 0, 0, 0, 0.3, 0.05)`
    ).run(now);
    db.prepare(
      `INSERT INTO wallets
       (id, name, starting_balance, size_multiplier, maker_enabled, maker_quote_size, maker_quote_width_bps, maker_min_spread_bps, maker_min_spread,
        maker_max_spread, maker_min_depth, maker_max_entropy, maker_max_vol, maker_inventory_target, maker_inventory_max_abs, maker_inventory_band,
        maker_inventory_skew_bps, maker_inventory_skew_size, maker_inventory_skew_bps_cap, maker_quote_improve_fraction,
        max_daily_loss_usd, max_drawdown_pct, cooldown_minutes, market_allowlist)
       VALUES (1, 'maker-1', 100000, 1, 1, 50, 20, NULL, 0.002,
               0.02, 10, NULL, NULL, 0, 500, 200,
               15, 0.5, NULL, 0,
               NULL, NULL, NULL, NULL)`
    ).run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('maker_enabled', '1')").run();

    const regimeGate = {
      computeState: () => 7,
      decideForState: () => ({
        allowed: false,
        mode: "blocked",
        sizeMultiplier: 0,
        state: 7,
        reason: "explicit_block",
        reasonCode: "explicit_block",
        reasonDetail: "blocked",
        scoreBps: -10,
        edgeLcbBps: -10,
        edgeUcbBps: -5,
        pFillLcb: 0.4,
        wavgBps: -10,
        count: 10,
        fillRate: 0.4,
        nOrders: 10,
        nFills: 4,
        nMarkouts: 10
      }),
      getLoadDiagnostics: () => ({
        loaded: true,
        usingLastGood: false,
        lastLoadError: null,
        manifestStampWanted: "s1",
        manifestStampLoaded: "s1",
        manifestPath: "/tmp/manifest.json",
        manifestMtimeMs: now
      })
    } as any;

    const info = vi.fn();
    const loop = new MakerLoop(
      {
        intervalMs: 1000,
        params: baseParams,
        maxStalenessSec: 60,
        maxFeatureAgeMs: 60_000,
        cancelLatencyMsMin: 10,
        cancelLatencyMsMax: 20,
        priceToleranceBps: 100000,
        executionPolicy: { mode: "PAPER" },
        observability: {
          loopTraceEnabled: true,
          loopTraceEveryMs: 0,
          loopTraceOnFreshIdle: true
        },
        pnlLimits: { maxDailyLossUsd: 500, maxDrawdownPct: 0.1, cooldownMinutes: 60 }
      },
      {
        sqlite: db,
        logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
        regimeGate
      }
    );

    await (loop as any).tick();

    const traceCall = info.mock.calls.find((call) => call[0]?.loopTrace?.loop === "maker");
    expect(traceCall).toBeTruthy();
    const trace = traceCall?.[0]?.loopTrace;
    expect(trace.feed.isFresh).toBe(true);
    expect(trace.outcome.placedOrders).toBe(0);
    expect(trace.outcome.whyIdle?.code).toBe("all_filtered_regime_blocked");
    expect(trace.topDecisions.length).toBeGreaterThan(0);
  });

  it("places shadow orders when feed is fresh and regime is explore", async () => {
    const db = new Database(":memory:");
    createSchema(db);

    const now = Date.now();
    db.prepare(
      `INSERT INTO markets (id, condition_id, rewards_min_size, rewards_max_spread, rewards_rates_json)
       VALUES ('m1', NULL, NULL, NULL, NULL)`
    ).run();
    db.prepare("INSERT INTO tokens (id, market_id, fee_rate_bps) VALUES ('t1', 'm1', NULL)").run();
    db.prepare(
      `INSERT INTO latest_features
       (token_id, market_id, ts, mid, spread, best_bid, best_ask, bid_depth_top, ask_depth_top, obi, microprice_minus_mid, staleness_sec, entropy_30m, vol30m)
       VALUES ('t1', 'm1', ?, 0.5, 0.01, 0.495, 0.505, 40, 40, 0, 0, 0, 0.3, 0.05)`
    ).run(now);
    db.prepare(
      `INSERT INTO wallets
       (id, name, starting_balance, size_multiplier, maker_enabled, maker_quote_size, maker_quote_width_bps, maker_min_spread_bps, maker_min_spread,
        maker_max_spread, maker_min_depth, maker_max_entropy, maker_max_vol, maker_inventory_target, maker_inventory_max_abs, maker_inventory_band,
        maker_inventory_skew_bps, maker_inventory_skew_size, maker_inventory_skew_bps_cap, maker_quote_improve_fraction,
        max_daily_loss_usd, max_drawdown_pct, cooldown_minutes, market_allowlist)
       VALUES (1, 'maker-1', 100000, 1, 1, 50, 20, NULL, 0.002,
               0.02, 10, NULL, NULL, 0, 500, 200,
               15, 0.5, NULL, 0,
               NULL, NULL, NULL, NULL)`
    ).run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('maker_enabled', '1')").run();

    const regimeGate = {
      computeState: () => 7,
      decideForState: () => ({
        allowed: true,
        mode: "explore",
        sizeMultiplier: 0.5,
        state: 7,
        reason: "sparse_explore",
        reasonCode: "sparse_explore",
        reasonDetail: "explore",
        scoreBps: 0.1,
        edgeLcbBps: 0.1,
        edgeUcbBps: 1,
        pFillLcb: 0.5,
        wavgBps: 0.1,
        count: 1,
        fillRate: 0.5,
        nOrders: 1,
        nFills: 1,
        nMarkouts: 1
      }),
      getWavgBps: () => 0.1,
      getLoadDiagnostics: () => ({
        loaded: true,
        usingLastGood: false,
        lastLoadError: null,
        manifestStampWanted: "s1",
        manifestStampLoaded: "s1",
        manifestPath: "/tmp/manifest.json",
        manifestMtimeMs: now
      })
    } as any;

    const info = vi.fn();
    const loop = new MakerLoop(
      {
        intervalMs: 1000,
        params: baseParams,
        maxStalenessSec: 60,
        maxFeatureAgeMs: 60_000,
        cancelLatencyMsMin: 10,
        cancelLatencyMsMax: 20,
        priceToleranceBps: 100000,
        executionPolicy: { mode: "PAPER" },
        observability: {
          loopTraceEnabled: true,
          loopTraceEveryMs: 0,
          loopTraceOnFreshIdle: true
        },
        pnlLimits: { maxDailyLossUsd: 500, maxDrawdownPct: 0.1, cooldownMinutes: 60 }
      },
      {
        sqlite: db,
        logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
        regimeGate
      }
    );

    await (loop as any).tick();

    const orders = db.prepare("SELECT COUNT(*) as c FROM shadow_orders").get() as { c: number };
    expect(orders.c).toBeGreaterThan(0);
    const sizes = db.prepare("SELECT size FROM shadow_orders").all() as Array<{ size: number }>;
    expect(sizes.every((row) => Number.isFinite(row.size) && row.size > 0 && row.size < 50)).toBe(true);
    const traceCall = info.mock.calls.find((call) => call[0]?.loopTrace?.loop === "maker");
    const trace = traceCall?.[0]?.loopTrace;
    expect(trace.outcome.placedOrders).toBeGreaterThan(0);
    expect(trace.outcome.whyIdle).toBeNull();
  });
});
