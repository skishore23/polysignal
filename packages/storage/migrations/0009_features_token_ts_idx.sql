-- Migration 0009: Add composite index for evaluation feature lookups
-- This dramatically speeds up queries that filter by token_id AND ts range
-- Critical for /api/evaluation which queries 10M+ features table

CREATE INDEX IF NOT EXISTS features_token_ts_idx ON features (token_id, ts DESC);
