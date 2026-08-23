-- Migration 0030: Ensure maker gate setting exists without overriding wallet flags.
-- NOTE: Wallet role (maker/taker) is managed explicitly per wallet; do not force-enable here.

INSERT OR IGNORE INTO settings (key, value) VALUES ('maker_enabled', '1');
