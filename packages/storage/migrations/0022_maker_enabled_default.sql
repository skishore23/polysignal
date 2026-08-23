PRAGMA foreign_keys=off;
BEGIN TRANSACTION;

ALTER TABLE wallets RENAME TO wallets_old;

CREATE TABLE wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  starting_balance REAL NOT NULL DEFAULT 100000,
  size_multiplier REAL NOT NULL DEFAULT 1,
  max_open_positions INTEGER NOT NULL DEFAULT 5,
  min_confidence REAL NOT NULL DEFAULT 0,
  min_edge REAL NOT NULL DEFAULT 0,
  auto_open_limit INTEGER NOT NULL DEFAULT 5,
  auto_trade_enabled INTEGER NOT NULL DEFAULT 1,
  maker_enabled INTEGER NOT NULL DEFAULT 0,
  maker_quote_size REAL NOT NULL DEFAULT 50,
  maker_quote_width_bps REAL NOT NULL DEFAULT 20,
  maker_min_spread REAL NOT NULL DEFAULT 0.002,
  maker_max_spread REAL NOT NULL DEFAULT 0.02,
  maker_min_depth REAL NOT NULL DEFAULT 20,
  maker_max_entropy REAL,
  maker_max_vol REAL,
  maker_inventory_target REAL NOT NULL DEFAULT 0,
  maker_inventory_max_abs REAL NOT NULL DEFAULT 500,
  maker_inventory_skew_bps REAL NOT NULL DEFAULT 15,
  maker_execution_mode TEXT NOT NULL DEFAULT 'SHADOW',
  created_at INTEGER NOT NULL,
  default_stop_loss_pct REAL,
  default_take_profit_pct REAL,
  default_max_loss_abs REAL,
  default_max_hold_sec INTEGER
);

INSERT INTO wallets (
  id, name, starting_balance, size_multiplier,
  max_open_positions, min_confidence, min_edge,
  auto_open_limit, auto_trade_enabled, maker_enabled,
  maker_quote_size, maker_quote_width_bps, maker_min_spread,
  maker_max_spread, maker_min_depth, maker_max_entropy,
  maker_max_vol, maker_inventory_target, maker_inventory_max_abs,
  maker_inventory_skew_bps, maker_execution_mode, created_at,
  default_stop_loss_pct, default_take_profit_pct,
  default_max_loss_abs, default_max_hold_sec
) SELECT
  id, name, starting_balance, size_multiplier,
  max_open_positions, min_confidence, min_edge,
  auto_open_limit, auto_trade_enabled, maker_enabled,
  maker_quote_size, maker_quote_width_bps, maker_min_spread,
  maker_max_spread, maker_min_depth, maker_max_entropy,
  maker_max_vol, maker_inventory_target, maker_inventory_max_abs,
  maker_inventory_skew_bps, maker_execution_mode, created_at,
  default_stop_loss_pct, default_take_profit_pct,
  default_max_loss_abs, default_max_hold_sec
FROM wallets_old;

DROP TABLE wallets_old;

COMMIT;
PRAGMA foreign_keys=on;
