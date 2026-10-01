-- Frozen report artifacts survive changes to marks and later corrections.
CREATE TABLE accounting_reports (
  report_id TEXT PRIMARY KEY,
  report_json TEXT NOT NULL,
  created_ts INTEGER NOT NULL
);
