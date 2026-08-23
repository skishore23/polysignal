-- Migration 0014: Latest snapshot tables for maker metrics/pnl

CREATE TABLE IF NOT EXISTS maker_metrics_latest (
  wallet_id INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  spread_capture REAL NOT NULL,
  inventory_skew REAL NOT NULL,
  q_min REAL NOT NULL,
  fill_rate REAL NOT NULL,
  PRIMARY KEY (wallet_id, token_id)
);

CREATE TABLE IF NOT EXISTS maker_pnl_latest (
  wallet_id INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  realized REAL NOT NULL,
  unrealized REAL NOT NULL,
  position REAL NOT NULL,
  avg_entry REAL NOT NULL,
  PRIMARY KEY (wallet_id, token_id)
);

CREATE INDEX IF NOT EXISTS maker_metrics_latest_ts_idx ON maker_metrics_latest (ts);
CREATE INDEX IF NOT EXISTS maker_pnl_latest_ts_idx ON maker_pnl_latest (ts);
