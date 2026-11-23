-- Schema only from retained canonical dev.sqlite_master, iteration197; no rows.
CREATE TABLE market_events (
  id TEXT PRIMARY KEY,
  slug TEXT,
  title TEXT,
  neg_risk INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE `markets` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text,
	`question` text,
	`active` integer DEFAULT 1 NOT NULL,
	`volume` real,
	`liquidity` real,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL
, condition_id TEXT, rewards_min_size REAL, rewards_max_spread REAL, rewards_rates_json TEXT, rewards_updated_at INTEGER, maker_base_fee REAL, taker_base_fee REAL, minimum_order_size REAL, minimum_tick_size REAL, event_id TEXT, neg_risk INTEGER NOT NULL DEFAULT 0);
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`market_id` text NOT NULL,
	`outcome` text,
	`name` text,
	`updated_at` integer NOT NULL
, fee_rate_bps INTEGER, fee_rate_updated_at INTEGER);
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
, max_daily_loss_usd REAL, max_drawdown_pct REAL, cooldown_minutes INTEGER, market_allowlist TEXT, taker_side TEXT NOT NULL DEFAULT 'BOTH', maker_inventory_band REAL NOT NULL DEFAULT 200, maker_inventory_skew_size REAL NOT NULL DEFAULT 0.5, maker_inventory_skew_bps_cap REAL, maker_min_spread_bps REAL, max_hold_minutes INTEGER, maker_quote_improve_fraction REAL, market_filter_json TEXT);
CREATE TABLE `latest_features` (
	`token_id` text PRIMARY KEY NOT NULL,
	`market_id` text,
	`ts` integer NOT NULL,
	`mid` real,
	`spread` real,
	`obi` real,
	`microprice` real,
	`microprice_minus_mid` real,
	`bid_depth_top` real,
	`ask_depth_top` real,
	`r10s` real,
	`r1m` real,
	`r5m` real,
	`accel_1m` real,
	`skew_30m` real,
	`entropy_30m` real,
	`vol30m` real,
	`staleness_sec` real,
	`best_bid` real,
	`best_ask` real,
	`recv_ts_ms` integer,
	`last_event_global_seq` integer
);
CREATE TABLE `clob_events` (
	`global_seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recv_ts_ms` integer NOT NULL,
	`conn_id` text NOT NULL,
	`token_id` text NOT NULL,
	`msg_type` text NOT NULL,
	`payload_json` text NOT NULL
);
CREATE TABLE external_priors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  source TEXT NOT NULL,
  probability REAL NOT NULL,
  confidence REAL NOT NULL,
  metadata_json TEXT
);
CREATE TABLE shadow_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  wallet_id INTEGER,
  token_id TEXT NOT NULL,
  market_id TEXT,
  side TEXT NOT NULL,
  kind TEXT NOT NULL, 
  price REAL,
  size REAL,
  expected_cancel_ts INTEGER,
  execution_mode TEXT NOT NULL,
  book_snapshot_json TEXT,
  source TEXT
, client_order_id TEXT, external_order_id TEXT, status TEXT, filled_size REAL, filled_price REAL, last_update_ts INTEGER, state_id INTEGER, pred_edge_bps REAL, pred_source TEXT, spread_bps REAL, fees_bps REAL, expected_slippage_bps REAL, expected_adverse_bps REAL, expected_queue_bps REAL, cost_bps REAL, net_edge_bps REAL, decision TEXT, decision_reason TEXT, mid_px REAL, spread_px REAL, delta_hat REAL, bid_px REAL, ask_px REAL, bid_depth REAL, ask_depth REAL, inventory_i_before REAL, inventory_i_after REAL, inventory_delta_abs REAL, inventory_penalty_bps REAL, net_edge_after_inventory_bps REAL, strategy_lane TEXT, decision_group_id TEXT, prior_p_hat REAL);
CREATE TABLE shadow_fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  price REAL,
  size REAL,
  method TEXT,
  note TEXT, trade_id TEXT,
  FOREIGN KEY(order_id) REFERENCES shadow_orders(id)
);
CREATE TABLE decision_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  wallet_id INTEGER,
  kind TEXT NOT NULL,
  decision TEXT NOT NULL,
  decision_reason TEXT,
  pred_edge_bps REAL,
  cost_bps REAL,
  net_edge_bps REAL,
  spread_bps REAL,
  fees_bps REAL,
  expected_slippage_bps REAL,
  mid_px REAL,
  spread_px REAL,
  delta_hat REAL,
  size REAL,
  bid_px REAL,
  ask_px REAL,
  bid_depth REAL,
  ask_depth REAL
, strategy_lane TEXT, decision_group_id TEXT);
