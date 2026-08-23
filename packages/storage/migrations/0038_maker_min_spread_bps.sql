-- Migration 0038: Policy v0 lane — one-way spread floor in bps (maker only quotes when spread_bps >= this)
-- Convention: one-way spread_bps = (ask-bid)/mid * 10_000. rt_spread_bps = 2 * one_way. Default NULL = no bps floor.
ALTER TABLE wallets ADD COLUMN maker_min_spread_bps REAL;
