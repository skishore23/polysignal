CREATE INDEX IF NOT EXISTS decision_log_decision_group_token_idx
  ON decision_log (decision_group_id, token_id);
