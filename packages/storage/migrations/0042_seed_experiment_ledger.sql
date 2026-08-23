-- Migration 0042: Seed experiment ledger with current knowledge (only when table empty)
-- Semicolons in hypothesis use char(59) to avoid migration script splitting
INSERT INTO experiment_runs (ts, git_hash, hypothesis, scope, confidence, params_json, results_json, verdict, next_action, notes, run_context_json)
SELECT 1736281200000, 'doc', 'Markout pipeline matches recomputation' || char(59) || ' sign convention tests pass.', 'metrics correctness', 'medium', NULL, NULL, 'works', NULL, NULL, '{"code_version":"doc","config_fingerprint":null,"db_snapshot":null}'
WHERE (SELECT COUNT(*) FROM experiment_runs) = 0
UNION ALL SELECT 1736281200000, 'doc', 'Lane policy_v0 + spread≥200 shows EV_bps > 0 at 10–20m in shadow KPI.', 'maker lane 200+', 'medium', NULL, NULL, 'works', NULL, NULL, '{"code_version":"doc","config_fingerprint":null,"db_snapshot":null}'
WHERE (SELECT COUNT(*) FROM experiment_runs) = 0
UNION ALL SELECT 1736281200000, 'doc', 'Taker (crossing) has realized markout < 0 in 50+ edge bucket' || char(59) || ' calibration correlation near 0' || char(59) || ' negative net.', 'taker', 'medium', NULL, NULL, 'doesnt', NULL, NULL, '{"code_version":"doc","config_fingerprint":null,"db_snapshot":null}'
WHERE (SELECT COUNT(*) FROM experiment_runs) = 0
UNION ALL SELECT 1736281200000, 'doc', 'deltaHat scale is mismatched vs realized moves (ratio ~O(50+))' || char(59) || ' raw deltaHat can''t be used as bps edge.', 'taker', 'medium', NULL, NULL, 'doesnt', NULL, NULL, '{"code_version":"doc","config_fingerprint":null,"db_snapshot":null}'
WHERE (SELECT COUNT(*) FROM experiment_runs) = 0
UNION ALL SELECT 1736281200000, 'doc', 'Exit policy causes fallback ≈ ~100% and extreme holds' || char(59) || ' throughput conversion not proven.', 'exit policy', 'medium', NULL, NULL, 'inconclusive', NULL, NULL, '{"code_version":"doc","config_fingerprint":null,"db_snapshot":null}'
WHERE (SELECT COUNT(*) FROM experiment_runs) = 0
UNION ALL SELECT 1736281200000, 'doc', 'CI basis currently fill/markout-level' || char(59) || ' cycle-level CI not yet implemented.', 'metrics correctness', 'medium', NULL, NULL, 'inconclusive', NULL, NULL, '{"code_version":"doc","config_fingerprint":null,"db_snapshot":null}'
WHERE (SELECT COUNT(*) FROM experiment_runs) = 0
