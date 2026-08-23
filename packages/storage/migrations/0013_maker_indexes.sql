-- Migration 0013: Tune maker table indexes for grouped lookups

CREATE INDEX IF NOT EXISTS maker_pnl_wallet_token_ts_idx ON maker_pnl (wallet_id, token_id, ts);
CREATE INDEX IF NOT EXISTS maker_pnl_token_wallet_id_idx ON maker_pnl (token_id, wallet_id, id);

CREATE INDEX IF NOT EXISTS maker_metrics_wallet_token_ts_idx ON maker_metrics (wallet_id, token_id, ts);
CREATE INDEX IF NOT EXISTS maker_metrics_token_wallet_ts_idx ON maker_metrics (token_id, wallet_id, ts);
