-- Migration 0015: Snapshot health tracking

CREATE TABLE IF NOT EXISTS maker_snapshot_health (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_tick INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS maker_snapshot_health_tick_idx ON maker_snapshot_health (last_tick);
