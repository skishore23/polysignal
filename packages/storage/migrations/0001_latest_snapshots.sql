CREATE TABLE IF NOT EXISTS latest_features (
  token_id TEXT PRIMARY KEY,
  market_id TEXT,
  ts INTEGER NOT NULL,
  mid REAL,
  spread REAL,
  obi REAL,
  microprice REAL,
  microprice_minus_mid REAL,
  bid_depth_top REAL,
  ask_depth_top REAL,
  r10s REAL,
  r1m REAL,
  r5m REAL,
  vol30m REAL,
  staleness_sec REAL
);

CREATE TABLE IF NOT EXISTS latest_signals (
  token_id TEXT NOT NULL,
  horizon_sec INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  signal TEXT NOT NULL,
  delta_hat REAL NOT NULL,
  confidence REAL NOT NULL,
  buffer REAL NOT NULL,
  reasons TEXT NOT NULL,
  PRIMARY KEY (token_id, horizon_sec)
);

CREATE INDEX IF NOT EXISTS features_token_ts_desc_idx ON features (token_id, ts DESC);
CREATE INDEX IF NOT EXISTS signals_token_horizon_ts_desc_idx ON signals (token_id, horizon_sec, ts DESC);
CREATE INDEX IF NOT EXISTS evidence_token_ts_desc_idx ON signal_evidence (token_id, ts DESC);
