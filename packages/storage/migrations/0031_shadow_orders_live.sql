-- Migration 0031: Add live execution metadata to shadow orders/fills

ALTER TABLE shadow_orders ADD COLUMN client_order_id TEXT;
ALTER TABLE shadow_orders ADD COLUMN external_order_id TEXT;
ALTER TABLE shadow_orders ADD COLUMN status TEXT;
ALTER TABLE shadow_orders ADD COLUMN filled_size REAL;
ALTER TABLE shadow_orders ADD COLUMN filled_price REAL;
ALTER TABLE shadow_orders ADD COLUMN last_update_ts INTEGER;

ALTER TABLE shadow_fills ADD COLUMN trade_id TEXT;

CREATE INDEX IF NOT EXISTS shadow_orders_external_order_idx ON shadow_orders (external_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS shadow_fills_order_trade_idx ON shadow_fills (order_id, trade_id);
