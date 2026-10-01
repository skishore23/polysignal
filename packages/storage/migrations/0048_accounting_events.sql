-- Immutable economic postings. Existing shadow fills are deliberately not backfilled.
CREATE TABLE accounting_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  account_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('OPENING','TRANSFER','FILL','SETTLEMENT','CORRECTION')),
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  order_id INTEGER,
  trade_id TEXT,
  token_id TEXT,
  side TEXT CHECK (side IN ('BUY','SELL') OR side IS NULL),
  event_ts INTEGER NOT NULL,
  receipt_ts INTEGER NOT NULL,
  processing_order INTEGER NOT NULL,
  finality TEXT NOT NULL CHECK (finality IN ('SIMULATED','CONFIRMED','PROVISIONAL','FAILED')),
  gross_shares REAL,
  net_shares_delta REAL,
  price REAL,
  cash_delta REAL,
  fee_asset TEXT CHECK (fee_asset IN ('USDC','SHARES') OR fee_asset IS NULL),
  fee_amount REAL,
  fee_evidence TEXT NOT NULL CHECK (fee_evidence IN ('OBSERVED','MODELED','MISSING','NOT_APPLICABLE')),
  rule_version TEXT NOT NULL,
  rounding_policy TEXT NOT NULL,
  collateral_asset TEXT NOT NULL,
  corrects_event_key TEXT UNIQUE,
  CHECK (kind != 'CORRECTION' OR corrects_event_key IS NOT NULL)
);
CREATE INDEX accounting_events_account_order_idx ON accounting_events (account_key, event_ts, processing_order, event_key);
CREATE INDEX accounting_events_source_idx ON accounting_events (source, source_ref);
