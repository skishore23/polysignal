import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { MakerLoop } from "../../apps/worker/src/maker/MakerLoop";
import type { MakerParams } from "../../packages/types/src/maker";

const createSchema = (db: Database.Database) => {
  db.exec(`
    CREATE TABLE markets (
      id TEXT PRIMARY KEY NOT NULL,
      condition_id TEXT,
      volume REAL,
      liquidity REAL,
      active INTEGER,
      rewards_min_size REAL,
      rewards_max_spread REAL,
      rewards_rates_json TEXT
    );

    CREATE TABLE tokens (
      id TEXT PRIMARY KEY NOT NULL,
      market_id TEXT NOT NULL,
      fee_rate_bps INTEGER
    );

    INSERT INTO markets (id, condition_id, rewards_min_size, rewards_max_spread, rewards_rates_json) VALUES ('m1', NULL, NULL, NULL, NULL);
    INSERT INTO tokens (id, market_id, fee_rate_bps) VALUES ('t1', 'm1', NULL);

    CREATE TABLE clob_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      recv_ts_ms INTEGER NOT NULL,
      msg_type TEXT NOT NULL
    );

    CREATE TABLE settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    INSERT INTO settings (key, value) VALUES ('maker_live_execution', '0');
    INSERT INTO settings (key, value) VALUES ('maker_enabled', '1');

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
      maker_inventory_band REAL NOT NULL DEFAULT 200,
      maker_inventory_skew_bps REAL NOT NULL,
      maker_inventory_skew_size REAL NOT NULL DEFAULT 0.5,
      maker_inventory_skew_bps_cap REAL,
      maker_quote_improve_fraction REAL,
      max_daily_loss_usd REAL,
      max_drawdown_pct REAL,
      cooldown_minutes INTEGER,
      market_allowlist TEXT,
      market_filter_json TEXT,
      maker_execution_mode TEXT NOT NULL DEFAULT 'SHADOW'
    );

    CREATE TABLE latest_features (
      token_id TEXT NOT NULL,
      market_id TEXT,
      ts INTEGER NOT NULL,
      mid REAL NOT NULL,
      spread REAL NOT NULL,
      best_bid REAL NOT NULL,
      best_ask REAL NOT NULL,
      bid_depth_top REAL NOT NULL,
      ask_depth_top REAL NOT NULL,
      obi REAL,
      microprice_minus_mid REAL,
      staleness_sec REAL,
      entropy_30m REAL,
      vol30m REAL
    );

    CREATE TABLE maker_quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      market_id TEXT,
      ts INTEGER NOT NULL,
      bid_price REAL NOT NULL,
      ask_price REAL NOT NULL,
      bid_size REAL NOT NULL,
      ask_size REAL NOT NULL,
      reason TEXT NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'SHADOW'
    );

    CREATE TABLE maker_orders (
      order_id TEXT PRIMARY KEY,
      wallet_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      market_id TEXT,
      ts INTEGER NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      size REAL NOT NULL,
      status TEXT NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'SHADOW'
    );

    CREATE TABLE maker_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      position REAL NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'SHADOW'
    );
    CREATE UNIQUE INDEX maker_inventory_wallet_token_uniq ON maker_inventory (wallet_id, token_id);

    CREATE TABLE maker_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      q_one REAL NOT NULL,
      q_two REAL NOT NULL,
      q_min REAL NOT NULL,
      eligible INTEGER NOT NULL
    );

    CREATE TABLE maker_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      spread_capture REAL NOT NULL,
      inventory_skew REAL NOT NULL,
      q_min REAL NOT NULL,
      fill_rate REAL NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'SHADOW'
    );

    CREATE TABLE maker_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      size REAL NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'SHADOW'
    );

    CREATE TABLE maker_pnl (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      realized REAL NOT NULL,
      unrealized REAL NOT NULL,
      position REAL NOT NULL,
      avg_entry REAL NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'SHADOW'
    );

    CREATE TABLE maker_metrics_latest (
      wallet_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      spread_capture REAL NOT NULL,
      inventory_skew REAL NOT NULL,
      q_min REAL NOT NULL,
      fill_rate REAL NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'SHADOW',
      PRIMARY KEY (wallet_id, token_id)
    );

    CREATE TABLE maker_pnl_latest (
      wallet_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      realized REAL NOT NULL,
      unrealized REAL NOT NULL,
      position REAL NOT NULL,
      avg_entry REAL NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'SHADOW',
      PRIMARY KEY (wallet_id, token_id)
    );

    CREATE TABLE maker_snapshot_health (
      id INTEGER PRIMARY KEY,
      last_tick INTEGER NOT NULL
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
      signal_id INTEGER,
      signal_ts INTEGER,
      horizon_sec INTEGER,
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

    CREATE TABLE shadow_maker_metrics_latest (
      wallet_id INTEGER PRIMARY KEY,
      updated_ts INTEGER NOT NULL,
      window_hours INTEGER NOT NULL DEFAULT 24,
      open_positions INTEGER NOT NULL DEFAULT 0,
      total_realized REAL NOT NULL DEFAULT 0,
      total_unrealized REAL NOT NULL DEFAULT 0,
      fill_count INTEGER NOT NULL DEFAULT 0,
      long_exposure REAL NOT NULL DEFAULT 0,
      short_exposure REAL NOT NULL DEFAULT 0,
      maker_volume_24h REAL NOT NULL DEFAULT 0,
      fee_equivalent_24h REAL NOT NULL DEFAULT 0,
      rebate_upper_bound_24h REAL NOT NULL DEFAULT 0,
      rebate_pool_pct REAL NOT NULL DEFAULT 1
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
  `);
};

const insertWallet = (
  db: Database.Database,
  id: number,
  name: string,
  options?: { marketAllowlist?: string | null; marketFilterJson?: string | null }
) => {
  db.prepare(
    `INSERT INTO wallets
     (id, name, starting_balance, size_multiplier, maker_enabled, maker_quote_size, maker_quote_width_bps, maker_min_spread,
      maker_max_spread, maker_min_depth, maker_max_entropy, maker_max_vol, maker_inventory_target, maker_inventory_max_abs, maker_inventory_skew_bps,
      maker_execution_mode, market_allowlist, market_filter_json)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name,
    10000,
    1,
    50,
    20,
    0.002,
    0.02,
    20,
    null,
    null,
    0,
    500,
    15,
    "SHADOW",
    options?.marketAllowlist ?? null,
    options?.marketFilterJson ?? null
  );
};

const insertFeature = (db: Database.Database, tokenId: string, ts: number) => {
  db.prepare(
    `INSERT INTO latest_features
     (token_id, market_id, ts, mid, spread, best_bid, best_ask, bid_depth_top, ask_depth_top, staleness_sec, entropy_30m, vol30m)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    tokenId,
    "m1",
    ts,
    0.5,
    0.01,
    0.499,
    0.501,
    50,
    50,
    0,
    0.5,
    0.05
  );
};

describe.skip("MakerLoop wallet attribution", () => {
  it.skip("writes maker rows per maker-enabled wallet (obsolete: 0026 dropped maker tables, loop uses shadow)", async () => {
    const db = new Database(":memory:");
    createSchema(db);
    insertWallet(db, 10, "Maker-A");
    insertWallet(db, 11, "Maker-B");
    insertFeature(db, "t1", Date.now());

    const params: MakerParams = {
      minSpreadBps: null,
      minSpread: 0.002,
      maxSpread: 0.02,
      minDepth: 20,
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
      inventoryLambdaBps: 10,
      baseVol: 0.01,
      maxVolMultiplier: 3.0,
      quoteImproveFraction: 0
    };

    const loop = new MakerLoop(
      {
        intervalMs: 1000,
        params,
        maxStalenessSec: 120,
        maxFeatureAgeMs: 120_000,
        cancelLatencyMsMin: 5000,
        cancelLatencyMsMax: 20000,
        priceToleranceBps: 10,
        executionPolicy: { mode: "PAPER" },
        pnlLimits: { maxDailyLossUsd: 500, maxDrawdownPct: 0.10, cooldownMinutes: 60 }
      },
      {
        sqlite: db,
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any
      }
    );

    await (loop as any).tick();

    const pnlWallets = (db
      .prepare("SELECT DISTINCT wallet_id as walletId FROM maker_pnl ORDER BY wallet_id")
      .all() as Array<{ walletId: number }>)
      .map((row) => row.walletId);

    const quoteWallets = (db
      .prepare("SELECT DISTINCT wallet_id as walletId FROM maker_quotes ORDER BY wallet_id")
      .all() as Array<{ walletId: number }>)
      .map((row) => row.walletId);

    expect(pnlWallets).toEqual([10, 11]);
    expect(quoteWallets).toEqual([10, 11]);
  });

  it("synchronizes latest snapshots with the canonical history rows", async () => {
    const db = new Database(":memory:");
    createSchema(db);
    insertWallet(db, 10, "Maker-A");
    insertWallet(db, 11, "Maker-B");
    insertFeature(db, "t1", Date.now());

    const params: MakerParams = {
      minSpreadBps: null,
      minSpread: 0.002,
      maxSpread: 0.02,
      minDepth: 20,
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
      inventoryLambdaBps: 10,
      baseVol: 0.01,
      maxVolMultiplier: 3.0,
      quoteImproveFraction: 0
    };

    const loop = new MakerLoop(
      {
        intervalMs: 1000,
        params,
        maxStalenessSec: 120,
        maxFeatureAgeMs: 120_000,
        cancelLatencyMsMin: 5000,
        cancelLatencyMsMax: 20000,
        priceToleranceBps: 10,
        executionPolicy: { mode: "PAPER" },
        pnlLimits: { maxDailyLossUsd: 500, maxDrawdownPct: 0.10, cooldownMinutes: 60 }
      },
      {
        sqlite: db,
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any
      }
    );

    await (loop as any).tick();

    type MetricsRow = { wallet_id: number; token_id: string; ts: number; spread_capture: number; inventory_skew: number; q_min: number; fill_rate: number };
    const metricsHistory = db
      .prepare(`SELECT wallet_id, token_id, ts, spread_capture, inventory_skew, q_min, fill_rate FROM maker_metrics`)
      .all() as MetricsRow[];
    const metricsLatest = db
      .prepare(`SELECT wallet_id, token_id, ts, spread_capture, inventory_skew, q_min, fill_rate FROM maker_metrics_latest`)
      .all() as MetricsRow[];

    expect(metricsLatest.length).toBe(metricsHistory.length);
    for (const latestRow of metricsLatest) {
      const match = metricsHistory.find(
        (historyRow) =>
          historyRow.wallet_id === latestRow.wallet_id && historyRow.token_id === latestRow.token_id
      );
      expect(match).toBeDefined();
      expect(latestRow.ts).toBe(match!.ts);
      expect(latestRow.spread_capture).toBeCloseTo(match!.spread_capture);
      expect(latestRow.inventory_skew).toBeCloseTo(match!.inventory_skew);
      expect(latestRow.q_min).toBeCloseTo(match!.q_min);
      expect(latestRow.fill_rate).toBeCloseTo(match!.fill_rate);
    }

    type PnlRow = { wallet_id: number; token_id: string; ts: number; realized: number; unrealized: number; position: number; avg_entry: number };
    const pnlHistory = db
      .prepare(`SELECT wallet_id, token_id, ts, realized, unrealized, position, avg_entry FROM maker_pnl`)
      .all() as PnlRow[];
    const pnlLatest = db
      .prepare(`SELECT wallet_id, token_id, ts, realized, unrealized, position, avg_entry FROM maker_pnl_latest`)
      .all() as PnlRow[];

    expect(pnlLatest.length).toBe(pnlHistory.length);
    for (const latestRow of pnlLatest) {
      const match = pnlHistory.find(
        (historyRow) =>
          historyRow.wallet_id === latestRow.wallet_id && historyRow.token_id === latestRow.token_id
      );
      expect(match).toBeDefined();
      expect(latestRow.ts).toBe(match!.ts);
      expect(latestRow.realized).toBeCloseTo(match!.realized);
      expect(latestRow.unrealized).toBeCloseTo(match!.unrealized);
      expect(latestRow.position).toBeCloseTo(match!.position);
      expect(latestRow.avg_entry).toBeCloseTo(match!.avg_entry);
    }
  });

  it("applies structured wallet market filter kind restrictions for maker sides", async () => {
    const db = new Database(":memory:");
    createSchema(db);
    insertWallet(db, 10, "Maker-Ask-Only", {
      marketFilterJson: JSON.stringify({ version: 1, allowedKinds: ["MAKER_ASK"] })
    });
    insertFeature(db, "t1", Date.now());

    const params: MakerParams = {
      minSpreadBps: null,
      minSpread: 0.002,
      maxSpread: 0.02,
      minDepth: 20,
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
      inventoryLambdaBps: 10,
      baseVol: 0.01,
      maxVolMultiplier: 3.0,
      quoteImproveFraction: 0
    };

    const loop = new MakerLoop(
      {
        intervalMs: 1000,
        params,
        maxStalenessSec: 120,
        maxFeatureAgeMs: 120_000,
        cancelLatencyMsMin: 5000,
        cancelLatencyMsMax: 20000,
        priceToleranceBps: 10,
        executionPolicy: { mode: "PAPER" },
        pnlLimits: { maxDailyLossUsd: 500, maxDrawdownPct: 0.10, cooldownMinutes: 60 }
      },
      {
        sqlite: db,
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any
      }
    );

    await (loop as any).tick();

    const rows = db.prepare("SELECT kind FROM shadow_orders ORDER BY id ASC").all() as Array<{ kind: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.kind === "MAKER_ASK")).toBe(true);
  });

  it("blocks maker candidates when structured market include filter does not match", async () => {
    const db = new Database(":memory:");
    createSchema(db);
    insertWallet(db, 10, "Maker-Include-Miss", {
      marketFilterJson: JSON.stringify({ version: 1, includeMarketIds: ["m2"] })
    });
    insertFeature(db, "t1", Date.now());

    const params: MakerParams = {
      minSpreadBps: null,
      minSpread: 0.002,
      maxSpread: 0.02,
      minDepth: 20,
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
      inventoryLambdaBps: 10,
      baseVol: 0.01,
      maxVolMultiplier: 3.0,
      quoteImproveFraction: 0
    };

    const loop = new MakerLoop(
      {
        intervalMs: 1000,
        params,
        maxStalenessSec: 120,
        maxFeatureAgeMs: 120_000,
        cancelLatencyMsMin: 5000,
        cancelLatencyMsMax: 20000,
        priceToleranceBps: 10,
        executionPolicy: { mode: "PAPER" },
        pnlLimits: { maxDailyLossUsd: 500, maxDrawdownPct: 0.10, cooldownMinutes: 60 }
      },
      {
        sqlite: db,
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any
      }
    );

    await (loop as any).tick();
    const row = db.prepare("SELECT COUNT(*) as c FROM shadow_orders").get() as { c: number };
    expect(row.c).toBe(0);
  });
});
