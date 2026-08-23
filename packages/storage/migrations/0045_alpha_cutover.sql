ALTER TABLE markets ADD COLUMN event_id TEXT;
ALTER TABLE markets ADD COLUMN neg_risk INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS market_events (
  id TEXT PRIMARY KEY,
  slug TEXT,
  title TEXT,
  neg_risk INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_markets (
  event_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, market_id)
);
CREATE INDEX IF NOT EXISTS event_markets_market_idx ON event_markets (market_id);

CREATE TABLE IF NOT EXISTS external_priors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  source TEXT NOT NULL,
  probability REAL NOT NULL,
  confidence REAL NOT NULL,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS external_priors_token_ts_idx ON external_priors (token_id, ts);
CREATE INDEX IF NOT EXISTS external_priors_source_ts_idx ON external_priors (source, ts);

CREATE TABLE IF NOT EXISTS arb_opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  event_id TEXT,
  type TEXT NOT NULL,
  direction TEXT NOT NULL,
  token_ids_json TEXT NOT NULL,
  expected_payout REAL NOT NULL,
  gross_edge_bps REAL NOT NULL,
  expected_cost_bps REAL NOT NULL,
  net_edge_bps REAL NOT NULL,
  decision_group_id TEXT NOT NULL,
  details_json TEXT,
  fingerprint TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS arb_opportunities_ts_idx ON arb_opportunities (ts);
CREATE UNIQUE INDEX IF NOT EXISTS arb_opportunities_fingerprint_idx ON arb_opportunities (fingerprint);

CREATE TABLE IF NOT EXISTS arb_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  opportunity_id INTEGER NOT NULL,
  decision_group_id TEXT NOT NULL,
  status TEXT NOT NULL,
  expected_net_edge_bps REAL NOT NULL,
  leg_count INTEGER NOT NULL,
  realized_pnl REAL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS arb_executions_opp_idx ON arb_executions (opportunity_id);
CREATE INDEX IF NOT EXISTS arb_executions_ts_idx ON arb_executions (ts);

ALTER TABLE shadow_orders ADD COLUMN strategy_lane TEXT;
ALTER TABLE shadow_orders ADD COLUMN decision_group_id TEXT;
ALTER TABLE shadow_orders ADD COLUMN prior_p_hat REAL;

CREATE INDEX IF NOT EXISTS shadow_orders_decision_group_idx ON shadow_orders (decision_group_id);
CREATE INDEX IF NOT EXISTS shadow_orders_strategy_lane_idx ON shadow_orders (strategy_lane);

ALTER TABLE decision_log ADD COLUMN strategy_lane TEXT;
ALTER TABLE decision_log ADD COLUMN decision_group_id TEXT;
