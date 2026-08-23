-- Add position-level default settings to wallets table
-- These allow per-wallet configuration of position parameters

ALTER TABLE wallets ADD COLUMN default_stop_loss_pct REAL;
ALTER TABLE wallets ADD COLUMN default_take_profit_pct REAL;
ALTER TABLE wallets ADD COLUMN default_max_loss_abs REAL;
ALTER TABLE wallets ADD COLUMN default_max_hold_sec INTEGER;
