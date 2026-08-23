-- Migration 0010: Maker tables

CREATE TABLE IF NOT EXISTS maker_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL,
  market_id TEXT,
  ts INTEGER NOT NULL,
  bid_price REAL NOT NULL,
  ask_price REAL NOT NULL,
  bid_size REAL NOT NULL,
  ask_size REAL NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS maker_quotes_token_idx ON maker_quotes (token_id);
CREATE INDEX IF NOT EXISTS maker_quotes_ts_idx ON maker_quotes (ts);

CREATE TABLE IF NOT EXISTS maker_orders (
  order_id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  market_id TEXT,
  ts INTEGER NOT NULL,
  side TEXT NOT NULL,
  price REAL NOT NULL,
  size REAL NOT NULL,
  status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS maker_orders_token_idx ON maker_orders (token_id);
CREATE INDEX IF NOT EXISTS maker_orders_ts_idx ON maker_orders (ts);

CREATE TABLE IF NOT EXISTS maker_inventory (
  token_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  position REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS maker_inventory_ts_idx ON maker_inventory (ts);

CREATE TABLE IF NOT EXISTS maker_rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  q_one REAL NOT NULL,
  q_two REAL NOT NULL,
  q_min REAL NOT NULL,
  eligible INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS maker_rewards_token_idx ON maker_rewards (token_id);
CREATE INDEX IF NOT EXISTS maker_rewards_ts_idx ON maker_rewards (ts);

CREATE TABLE IF NOT EXISTS maker_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  spread_capture REAL NOT NULL,
  inventory_skew REAL NOT NULL,
  q_min REAL NOT NULL,
  fill_rate REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS maker_metrics_token_idx ON maker_metrics (token_id);
CREATE INDEX IF NOT EXISTS maker_metrics_ts_idx ON maker_metrics (ts);

CREATE TABLE IF NOT EXISTS maker_fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  side TEXT NOT NULL,
  price REAL NOT NULL,
  size REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS maker_fills_token_idx ON maker_fills (token_id);
CREATE INDEX IF NOT EXISTS maker_fills_ts_idx ON maker_fills (ts);

CREATE TABLE IF NOT EXISTS maker_pnl (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  realized REAL NOT NULL,
  unrealized REAL NOT NULL,
  position REAL NOT NULL,
  avg_entry REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS maker_pnl_token_idx ON maker_pnl (token_id);
CREATE INDEX IF NOT EXISTS maker_pnl_ts_idx ON maker_pnl (ts);
