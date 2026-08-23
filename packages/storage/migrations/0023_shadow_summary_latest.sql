-- Migration 0023: Pre-computed shadow execution summary for fast API queries
-- The shadow API was running 14+ expensive queries with JOINs across shadow tables.
-- This table caches rolling-window aggregates, updated by the worker.

CREATE TABLE IF NOT EXISTS shadow_summary_latest (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Single row, singleton pattern
  updated_ts INTEGER NOT NULL,
  window_hours INTEGER NOT NULL DEFAULT 24,
  
  -- Maker metrics
  maker_orders INTEGER NOT NULL DEFAULT 0,
  maker_fills INTEGER NOT NULL DEFAULT 0,
  maker_real_fills INTEGER NOT NULL DEFAULT 0,
  maker_synthetic_fills INTEGER NOT NULL DEFAULT 0,
  maker_markout_5s_bps REAL,
  maker_markout_30s_bps REAL,
  maker_last_ts INTEGER,
  
  -- Taker metrics
  taker_orders INTEGER NOT NULL DEFAULT 0,
  taker_fills INTEGER NOT NULL DEFAULT 0,
  taker_real_fills INTEGER NOT NULL DEFAULT 0,
  taker_synthetic_fills INTEGER NOT NULL DEFAULT 0,
  taker_markout_5s_bps REAL,
  taker_markout_30s_bps REAL,
  taker_last_ts INTEGER
);

-- Seed initial row
INSERT OR IGNORE INTO shadow_summary_latest (
  id, updated_ts, window_hours,
  maker_orders, maker_fills, maker_real_fills, maker_synthetic_fills,
  taker_orders, taker_fills, taker_real_fills, taker_synthetic_fills
) VALUES (
  1, 0, 24,
  0, 0, 0, 0,
  0, 0, 0, 0
);

-- Add missing indexes for shadow queries that filter by ts and kind
CREATE INDEX IF NOT EXISTS shadow_orders_ts_idx ON shadow_orders (ts);
CREATE INDEX IF NOT EXISTS shadow_orders_kind_ts_idx ON shadow_orders (kind, ts);
CREATE INDEX IF NOT EXISTS shadow_markouts_ts_idx ON shadow_markouts (ts);
