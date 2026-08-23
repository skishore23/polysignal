-- Migration 0039: Policy v0 risk product — max hold time (minutes) per wallet; force fallback after this.
ALTER TABLE wallets ADD COLUMN max_hold_minutes INTEGER;
