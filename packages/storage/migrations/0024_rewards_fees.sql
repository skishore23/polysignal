-- Migration 0024: Add Polymarket rewards + fee-rate metadata

ALTER TABLE markets ADD COLUMN condition_id TEXT;
ALTER TABLE markets ADD COLUMN rewards_min_size REAL;
ALTER TABLE markets ADD COLUMN rewards_max_spread REAL;
ALTER TABLE markets ADD COLUMN rewards_rates_json TEXT;
ALTER TABLE markets ADD COLUMN rewards_updated_at INTEGER;
ALTER TABLE markets ADD COLUMN maker_base_fee REAL;
ALTER TABLE markets ADD COLUMN taker_base_fee REAL;
ALTER TABLE markets ADD COLUMN minimum_order_size REAL;
ALTER TABLE markets ADD COLUMN minimum_tick_size REAL;

ALTER TABLE tokens ADD COLUMN fee_rate_bps INTEGER;
ALTER TABLE tokens ADD COLUMN fee_rate_updated_at INTEGER;
