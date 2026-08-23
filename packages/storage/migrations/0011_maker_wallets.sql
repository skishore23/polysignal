-- Migration 0011: Maker wallets and wallet_id attribution

ALTER TABLE wallets ADD COLUMN maker_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wallets ADD COLUMN maker_quote_size REAL NOT NULL DEFAULT 50;
ALTER TABLE wallets ADD COLUMN maker_quote_width_bps REAL NOT NULL DEFAULT 20;
ALTER TABLE wallets ADD COLUMN maker_min_spread REAL NOT NULL DEFAULT 0.002;
ALTER TABLE wallets ADD COLUMN maker_max_spread REAL NOT NULL DEFAULT 0.02;
ALTER TABLE wallets ADD COLUMN maker_min_depth REAL NOT NULL DEFAULT 20;
ALTER TABLE wallets ADD COLUMN maker_max_entropy REAL;
ALTER TABLE wallets ADD COLUMN maker_max_vol REAL;
ALTER TABLE wallets ADD COLUMN maker_inventory_target REAL NOT NULL DEFAULT 0;
ALTER TABLE wallets ADD COLUMN maker_inventory_max_abs REAL NOT NULL DEFAULT 500;
ALTER TABLE wallets ADD COLUMN maker_inventory_skew_bps REAL NOT NULL DEFAULT 15;

ALTER TABLE maker_quotes ADD COLUMN wallet_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE maker_orders ADD COLUMN wallet_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE maker_inventory ADD COLUMN wallet_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE maker_rewards ADD COLUMN wallet_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE maker_metrics ADD COLUMN wallet_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE maker_fills ADD COLUMN wallet_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE maker_pnl ADD COLUMN wallet_id INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS maker_quotes_wallet_idx ON maker_quotes (wallet_id);
CREATE INDEX IF NOT EXISTS maker_orders_wallet_idx ON maker_orders (wallet_id);
CREATE INDEX IF NOT EXISTS maker_inventory_wallet_idx ON maker_inventory (wallet_id);
CREATE INDEX IF NOT EXISTS maker_rewards_wallet_idx ON maker_rewards (wallet_id);
CREATE INDEX IF NOT EXISTS maker_metrics_wallet_idx ON maker_metrics (wallet_id);
CREATE INDEX IF NOT EXISTS maker_fills_wallet_idx ON maker_fills (wallet_id);
CREATE INDEX IF NOT EXISTS maker_pnl_wallet_idx ON maker_pnl (wallet_id);
