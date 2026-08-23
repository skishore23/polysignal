-- Migration 0021: Shadow execution state + markouts

CREATE TABLE IF NOT EXISTS shadow_state (
  id INTEGER PRIMARY KEY,
  last_trade_seq INTEGER NOT NULL DEFAULT 0,
  last_fill_id INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO shadow_state (id, last_trade_seq, last_fill_id)
VALUES (1, 0, 0);

CREATE TABLE IF NOT EXISTS shadow_markouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fill_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  horizon_ms INTEGER NOT NULL,
  mid_at_fill REAL,
  mid_at_horizon REAL,
  markout_bps REAL,
  FOREIGN KEY(fill_id) REFERENCES shadow_fills(id)
);

CREATE INDEX IF NOT EXISTS shadow_markouts_fill_idx ON shadow_markouts (fill_id);
CREATE INDEX IF NOT EXISTS shadow_markouts_horizon_idx ON shadow_markouts (horizon_ms);

CREATE INDEX IF NOT EXISTS shadow_orders_token_cancel_idx
  ON shadow_orders (token_id, expected_cancel_ts);
