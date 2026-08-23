-- Migration 0044: Structured wallet-level market filter JSON

ALTER TABLE wallets ADD COLUMN market_filter_json TEXT;
