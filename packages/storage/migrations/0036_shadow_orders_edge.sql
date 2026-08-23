-- Migration 0036: Unified edge trace + decision audit + raw snapshots for shadow_orders
-- Also adds decision_log for SKIP events (count skips by reason in Liquidity Gate UI)

-- Prediction
ALTER TABLE shadow_orders ADD COLUMN pred_edge_bps REAL;
ALTER TABLE shadow_orders ADD COLUMN pred_source TEXT;

-- Cost components
ALTER TABLE shadow_orders ADD COLUMN spread_bps REAL;
ALTER TABLE shadow_orders ADD COLUMN fees_bps REAL;
ALTER TABLE shadow_orders ADD COLUMN expected_slippage_bps REAL;
ALTER TABLE shadow_orders ADD COLUMN expected_adverse_bps REAL;
ALTER TABLE shadow_orders ADD COLUMN expected_queue_bps REAL;

-- Rollup
ALTER TABLE shadow_orders ADD COLUMN cost_bps REAL;
ALTER TABLE shadow_orders ADD COLUMN net_edge_bps REAL;

-- Decision audit
ALTER TABLE shadow_orders ADD COLUMN decision TEXT;
ALTER TABLE shadow_orders ADD COLUMN decision_reason TEXT;

-- Raw snapshots
ALTER TABLE shadow_orders ADD COLUMN mid_px REAL;
ALTER TABLE shadow_orders ADD COLUMN spread_px REAL;
ALTER TABLE shadow_orders ADD COLUMN delta_hat REAL;
ALTER TABLE shadow_orders ADD COLUMN bid_px REAL;
ALTER TABLE shadow_orders ADD COLUMN ask_px REAL;
ALTER TABLE shadow_orders ADD COLUMN bid_depth REAL;
ALTER TABLE shadow_orders ADD COLUMN ask_depth REAL;

-- decision_log: SKIP events for Liquidity Gate UI (skips by reason)
CREATE TABLE IF NOT EXISTS decision_log (
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
  delta_hat REAL,
  size REAL,
  bid_px REAL,
  ask_px REAL,
  bid_depth REAL,
  ask_depth REAL
);

CREATE INDEX IF NOT EXISTS decision_log_ts_idx ON decision_log (ts);
CREATE INDEX IF NOT EXISTS decision_log_kind_decision_idx ON decision_log (kind, decision);
CREATE INDEX IF NOT EXISTS decision_log_reason_idx ON decision_log (decision_reason);
