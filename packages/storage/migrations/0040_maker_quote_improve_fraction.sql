-- Migration 0040: Quote aggressiveness q ∈ [0, 0.5]; pull quotes toward touch for faster fill.
ALTER TABLE wallets ADD COLUMN maker_quote_improve_fraction REAL;
