-- Migration 0025: Add composite indexes for wallet position queries
CREATE INDEX IF NOT EXISTS positions_wallet_ts_open_idx ON paper_positions (wallet_id, ts_open);
CREATE INDEX IF NOT EXISTS positions_wallet_ts_close_idx ON paper_positions (wallet_id, ts_close);
