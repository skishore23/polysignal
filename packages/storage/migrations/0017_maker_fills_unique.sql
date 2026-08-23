-- Migration 0017: Add UNIQUE constraint to maker_fills to prevent duplicates
-- This ensures that the same fill cannot be inserted twice
-- (same wallet, token, timestamp, side, price, and size)

CREATE UNIQUE INDEX IF NOT EXISTS maker_fills_unique_idx 
ON maker_fills (wallet_id, token_id, ts, side, price, size);
