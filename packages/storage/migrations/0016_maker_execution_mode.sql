-- Migration: Add execution mode for dual-wallet maker system (real + synthetic)
-- This enables running LIVE and SHADOW wallets simultaneously against real market data.

-- Global execution flag (stored in settings table)
-- 0 = ALL wallets run SHADOW (global override)
-- 1 = Each wallet runs per its maker_execution_mode
INSERT OR IGNORE INTO settings (key, value) VALUES ('maker_live_execution', '0');

-- Per-wallet execution mode (SHADOW by default for safety)
ALTER TABLE wallets ADD COLUMN maker_execution_mode TEXT NOT NULL DEFAULT 'SHADOW';

-- Tag all maker tables with execution_mode for filtering/comparison
ALTER TABLE maker_quotes ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'SHADOW';
ALTER TABLE maker_orders ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'SHADOW';
ALTER TABLE maker_inventory ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'SHADOW';
ALTER TABLE maker_metrics ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'SHADOW';
ALTER TABLE maker_metrics_latest ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'SHADOW';
ALTER TABLE maker_fills ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'SHADOW';
ALTER TABLE maker_pnl ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'SHADOW';
ALTER TABLE maker_pnl_latest ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'SHADOW';

-- Indexes for efficient filtering by execution mode
CREATE INDEX IF NOT EXISTS maker_fills_exec_mode_idx ON maker_fills (execution_mode);
CREATE INDEX IF NOT EXISTS maker_pnl_exec_mode_idx ON maker_pnl (execution_mode);
CREATE INDEX IF NOT EXISTS maker_pnl_latest_exec_mode_idx ON maker_pnl_latest (execution_mode);
CREATE INDEX IF NOT EXISTS maker_metrics_exec_mode_idx ON maker_metrics (execution_mode);
CREATE INDEX IF NOT EXISTS maker_metrics_latest_exec_mode_idx ON maker_metrics_latest (execution_mode);
