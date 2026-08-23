-- Migration 0029: Per-wallet risk limits + market allowlist

ALTER TABLE wallets ADD COLUMN max_daily_loss_usd REAL;
ALTER TABLE wallets ADD COLUMN max_drawdown_pct REAL;
ALTER TABLE wallets ADD COLUMN cooldown_minutes INTEGER;
ALTER TABLE wallets ADD COLUMN market_allowlist TEXT;
