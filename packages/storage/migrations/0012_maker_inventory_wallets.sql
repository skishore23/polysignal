-- Migration 0012: Allow maker inventory per wallet

CREATE TABLE IF NOT EXISTS maker_inventory_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id INTEGER NOT NULL DEFAULT 1,
  token_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  position REAL NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS maker_inventory_wallet_token_uniq
  ON maker_inventory_v2 (wallet_id, token_id);

INSERT INTO maker_inventory_v2 (wallet_id, token_id, ts, position)
SELECT wallet_id, token_id, ts, position
FROM maker_inventory;

DROP TABLE maker_inventory;

ALTER TABLE maker_inventory_v2 RENAME TO maker_inventory;

CREATE UNIQUE INDEX IF NOT EXISTS maker_inventory_wallet_token_uniq ON maker_inventory (wallet_id, token_id);
CREATE INDEX IF NOT EXISTS maker_inventory_wallet_idx ON maker_inventory (wallet_id);
CREATE INDEX IF NOT EXISTS maker_inventory_token_idx ON maker_inventory (token_id);
CREATE INDEX IF NOT EXISTS maker_inventory_ts_idx ON maker_inventory (ts);
