-- Migration 0043: speed up shadow markout anti-join lookup per (horizon, fill)
CREATE INDEX IF NOT EXISTS shadow_markouts_horizon_fill_idx
  ON shadow_markouts (horizon_ms, fill_id);
