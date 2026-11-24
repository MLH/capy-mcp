CREATE INDEX login_transactions_expiry ON login_transactions (expires_at);
CREATE INDEX browser_sessions_expiry ON browser_sessions (expires_at);
CREATE INDEX browser_sessions_binding ON browser_sessions (csrf_hash, account_id, expires_at);
CREATE INDEX app_grants_cleanup_revoked ON app_grants (account_id)
  WHERE revoked_at IS NOT NULL AND instr(provider_grant_id, ':') = 0;
CREATE INDEX app_grants_cleanup_generation ON app_grants (account_id, credential_version, authorization_epoch)
  WHERE revoked_at IS NULL AND instr(provider_grant_id, ':') = 0;
