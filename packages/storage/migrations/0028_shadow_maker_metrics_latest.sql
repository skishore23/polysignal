-- Migration 0028: Cached maker metrics for fast UI queries (per wallet + global)
CREATE TABLE IF NOT EXISTS shadow_maker_metrics_latest (
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
CREATE INDEX IF NOT EXISTS shadow_maker_metrics_updated_idx ON shadow_maker_metrics_latest (updated_ts);
