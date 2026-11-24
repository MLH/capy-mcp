CREATE TABLE pending_authorizations (
  id_hash TEXT PRIMARY KEY NOT NULL,
  request_json TEXT NOT NULL,
  session_csrf_hash TEXT,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX pending_authorizations_expiry ON pending_authorizations (expires_at);

CREATE TABLE consent_snapshots (
  handle_hash TEXT PRIMARY KEY NOT NULL,
  session_csrf_hash TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  credential_version INTEGER NOT NULL,
  authorization_epoch INTEGER NOT NULL,
  client_label TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX consent_snapshots_expiry ON consent_snapshots (expires_at);
