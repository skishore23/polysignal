-- Migration 0035: Add state_id to shadow_orders for regime attribution at decision time

ALTER TABLE shadow_orders ADD COLUMN state_id INTEGER;
