-- Migration 0046: Decision-only hard cutover
-- Drops legacy signal-era tables and columns after decision/shadow pipeline is live.

DROP TABLE IF EXISTS latest_signals;
DROP TABLE IF EXISTS signal_evidence;
DROP TABLE IF EXISTS hourly_signals;
DROP TABLE IF EXISTS signals;

ALTER TABLE shadow_orders DROP COLUMN signal_id;
ALTER TABLE shadow_orders DROP COLUMN signal_ts;
ALTER TABLE shadow_orders DROP COLUMN horizon_sec;

CREATE INDEX IF NOT EXISTS decision_log_ts_token_kind_idx
  ON decision_log (ts, token_id, kind);

CREATE INDEX IF NOT EXISTS shadow_orders_decision_group_strategy_ts_idx
  ON shadow_orders (decision_group_id, strategy_lane, ts);

CREATE INDEX IF NOT EXISTS shadow_fills_order_ts_idx
  ON shadow_fills (order_id, ts);

CREATE INDEX IF NOT EXISTS shadow_markouts_fill_horizon_idx
  ON shadow_markouts (fill_id, horizon_ms);
