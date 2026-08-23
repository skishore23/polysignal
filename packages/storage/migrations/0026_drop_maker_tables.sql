-- Migration 0026: Remove maker tables (shadow-only mode)
DROP TABLE IF EXISTS maker_quotes;
DROP TABLE IF EXISTS maker_orders;
DROP TABLE IF EXISTS maker_inventory;
DROP TABLE IF EXISTS maker_rewards;
DROP TABLE IF EXISTS maker_metrics;
DROP TABLE IF EXISTS maker_metrics_latest;
DROP TABLE IF EXISTS maker_fills;
DROP TABLE IF EXISTS maker_pnl;
DROP TABLE IF EXISTS maker_pnl_latest;
DROP TABLE IF EXISTS maker_snapshot_health;

-- Remove maker rollups
DROP TABLE IF EXISTS hourly_maker_metrics;
DROP TABLE IF EXISTS hourly_maker_fills;
DROP TABLE IF EXISTS daily_maker_pnl;
DROP TABLE IF EXISTS hourly_maker_rewards;
