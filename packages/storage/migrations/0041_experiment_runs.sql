-- Migration 0041: Experiment ledger — run ID, hypothesis, params, results, verdict, run_context
CREATE TABLE IF NOT EXISTS experiment_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  git_hash TEXT,
  hypothesis TEXT NOT NULL,
  scope TEXT,
  confidence TEXT,
  params_json TEXT,
  results_json TEXT,
  verdict TEXT NOT NULL,
  next_action TEXT,
  notes TEXT,
  run_context_json TEXT
);

CREATE INDEX IF NOT EXISTS experiment_runs_ts_idx ON experiment_runs (ts);
CREATE INDEX IF NOT EXISTS experiment_runs_verdict_idx ON experiment_runs (verdict);
CREATE INDEX IF NOT EXISTS experiment_runs_scope_idx ON experiment_runs (scope);
