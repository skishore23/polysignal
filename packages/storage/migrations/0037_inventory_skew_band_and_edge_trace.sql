-- Migration 0037: Inventory skew band, size skew, and decision-causal edge-trace columns

-- Wallets: band (Level 2 one-sided quoting) and k_size (size skew)
ALTER TABLE wallets ADD COLUMN maker_inventory_band REAL NOT NULL DEFAULT 200;
ALTER TABLE wallets ADD COLUMN maker_inventory_skew_size REAL NOT NULL DEFAULT 0.5;
ALTER TABLE wallets ADD COLUMN maker_inventory_skew_bps_cap REAL;

-- shadow_orders: decision-causal inventory fields (Δ|I|-based penalty)
ALTER TABLE shadow_orders ADD COLUMN inventory_i_before REAL;
ALTER TABLE shadow_orders ADD COLUMN inventory_i_after REAL;
ALTER TABLE shadow_orders ADD COLUMN inventory_delta_abs REAL;
ALTER TABLE shadow_orders ADD COLUMN inventory_penalty_bps REAL;
ALTER TABLE shadow_orders ADD COLUMN net_edge_after_inventory_bps REAL;
