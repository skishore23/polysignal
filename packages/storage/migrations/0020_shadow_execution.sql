-- Migration 0020: Shadow execution tables for maker/taker realism

CREATE TABLE IF NOT EXISTS shadow_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  wallet_id INTEGER,
  token_id TEXT NOT NULL,
  market_id TEXT,
  side TEXT NOT NULL,
  kind TEXT NOT NULL, -- MAKER_BID | MAKER_ASK | TAKER_BUY | TAKER_SELL
  price REAL,
  size REAL,
  expected_cancel_ts INTEGER,
  signal_id INTEGER,
  signal_ts INTEGER,
  horizon_sec INTEGER,
  execution_mode TEXT NOT NULL,
  book_snapshot_json TEXT,
  source TEXT
);

CREATE INDEX IF NOT EXISTS shadow_orders_token_ts_idx ON shadow_orders (token_id, ts DESC);
CREATE INDEX IF NOT EXISTS shadow_orders_wallet_ts_idx ON shadow_orders (wallet_id, ts DESC);

CREATE TABLE IF NOT EXISTS shadow_fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  price REAL,
  size REAL,
  method TEXT,
  note TEXT,
  FOREIGN KEY(order_id) REFERENCES shadow_orders(id)
);

CREATE INDEX IF NOT EXISTS shadow_fills_order_idx ON shadow_fills (order_id);
CREATE INDEX IF NOT EXISTS shadow_fills_ts_idx ON shadow_fills (ts);
