CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`token_id` text,
	`market_id` text,
	`payload` text NOT NULL,
	`delivered` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alerts_ts_idx` ON `alerts` (`ts`);--> statement-breakpoint
CREATE TABLE `clob_events` (
	`global_seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recv_ts_ms` integer NOT NULL,
	`conn_id` text NOT NULL,
	`token_id` text NOT NULL,
	`msg_type` text NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `clob_events_token_idx` ON `clob_events` (`token_id`);--> statement-breakpoint
CREATE INDEX `clob_events_recv_ts_idx` ON `clob_events` (`recv_ts_ms`);--> statement-breakpoint
CREATE INDEX `clob_events_token_recv_ts_idx` ON `clob_events` (`token_id`,`recv_ts_ms`);--> statement-breakpoint
CREATE TABLE `features` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`token_id` text NOT NULL,
	`market_id` text,
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
--> statement-breakpoint
CREATE INDEX `features_token_idx` ON `features` (`token_id`);--> statement-breakpoint
CREATE INDEX `features_ts_idx` ON `features` (`ts`);--> statement-breakpoint
CREATE INDEX `features_last_event_global_seq_idx` ON `features` (`last_event_global_seq`);--> statement-breakpoint
CREATE INDEX `features_recv_ts_idx` ON `features` (`recv_ts_ms`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `latest_signals` (
	`token_id` text NOT NULL,
	`horizon_sec` integer NOT NULL,
	`ts` integer NOT NULL,
	`signal` text NOT NULL,
	`delta_hat` real NOT NULL,
	`confidence` real NOT NULL,
	`buffer` real NOT NULL,
	`reasons` text NOT NULL,
	PRIMARY KEY(`token_id`, `horizon_sec`)
);
--> statement-breakpoint
CREATE INDEX `latest_signals_token_idx` ON `latest_signals` (`token_id`);--> statement-breakpoint
CREATE TABLE `markets` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text,
	`question` text,
	`active` integer DEFAULT 1 NOT NULL,
	`volume` real,
	`liquidity` real,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `paper_positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts_open` integer NOT NULL,
	`ts_close` integer,
	`token_id` text NOT NULL,
	`market_id` text,
	`side` text NOT NULL,
	`size` real NOT NULL,
	`entry_price` real NOT NULL,
	`exit_price` real,
	`status` text NOT NULL,
	`stop_loss_pct` real,
	`take_profit_pct` real,
	`max_loss_abs` real,
	`max_hold_sec` integer,
	`exit_reason` text,
	`wallet_id` integer DEFAULT 1 NOT NULL,
	`opened_by_signal_id` integer,
	`entry_bid` real,
	`entry_ask` real,
	`exit_bid` real,
	`exit_ask` real,
	`entry_last_event_global_seq` integer,
	`exit_last_event_global_seq` integer
);
--> statement-breakpoint
CREATE INDEX `positions_token_idx` ON `paper_positions` (`token_id`);--> statement-breakpoint
CREATE INDEX `positions_status_idx` ON `paper_positions` (`status`);--> statement-breakpoint
CREATE INDEX `positions_wallet_idx` ON `paper_positions` (`wallet_id`);--> statement-breakpoint
CREATE INDEX `positions_opened_by_signal_idx` ON `paper_positions` (`opened_by_signal_id`);--> statement-breakpoint
CREATE INDEX `positions_entry_last_event_global_seq_idx` ON `paper_positions` (`entry_last_event_global_seq`);--> statement-breakpoint
CREATE INDEX `positions_exit_last_event_global_seq_idx` ON `paper_positions` (`exit_last_event_global_seq`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `signal_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`signal_id` integer,
	`ts` integer NOT NULL,
	`token_id` text NOT NULL,
	`market_id` text,
	`horizon_sec` integer NOT NULL,
	`snapshot` text NOT NULL,
	`features` text NOT NULL,
	`model` text NOT NULL,
	`delta_hat` real NOT NULL,
	`confidence` real NOT NULL,
	`buffer` real NOT NULL,
	`counterfactual` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evidence_token_idx` ON `signal_evidence` (`token_id`);--> statement-breakpoint
CREATE INDEX `evidence_ts_idx` ON `signal_evidence` (`ts`);--> statement-breakpoint
CREATE TABLE `signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`token_id` text NOT NULL,
	`market_id` text,
	`horizon_sec` integer NOT NULL,
	`signal` text NOT NULL,
	`delta_hat` real NOT NULL,
	`confidence` real NOT NULL,
	`buffer` real NOT NULL,
	`reasons` text NOT NULL,
	`feature_ts_ms_used` integer,
	`feature_last_event_global_seq_used` integer
);
--> statement-breakpoint
CREATE INDEX `signals_token_idx` ON `signals` (`token_id`);--> statement-breakpoint
CREATE INDEX `signals_ts_idx` ON `signals` (`ts`);--> statement-breakpoint
CREATE INDEX `signals_feature_ts_ms_used_idx` ON `signals` (`feature_ts_ms_used`);--> statement-breakpoint
CREATE INDEX `signals_feature_last_event_global_seq_used_idx` ON `signals` (`feature_last_event_global_seq_used`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`market_id` text NOT NULL,
	`outcome` text,
	`name` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tokens_market_idx` ON `tokens` (`market_id`);--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`starting_balance` real DEFAULT 100000 NOT NULL,
	`size_multiplier` real DEFAULT 1 NOT NULL,
	`max_open_positions` integer DEFAULT 5 NOT NULL,
	`min_confidence` real DEFAULT 0 NOT NULL,
	`min_edge` real DEFAULT 0 NOT NULL,
	`auto_open_limit` integer DEFAULT 5 NOT NULL,
	`auto_trade_enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
