-- Migration 0008: Add composite index for evaluation queries
-- This index optimizes the evaluation page queries that filter by horizon_sec and ts

CREATE INDEX IF NOT EXISTS signals_horizon_ts_idx ON signals (horizon_sec, ts DESC);
