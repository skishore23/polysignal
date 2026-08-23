-- Migration 0027: Normalize execution_mode labels to SHADOW

UPDATE wallets
SET maker_execution_mode = 'SHADOW'
WHERE maker_execution_mode IS NULL OR maker_execution_mode = 'SIMULATION';

UPDATE shadow_orders
SET execution_mode = 'SHADOW'
WHERE execution_mode = 'SIMULATION' OR execution_mode IS NULL;
