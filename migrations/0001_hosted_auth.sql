CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  admission_claims TEXT NOT NULL CHECK (json_type(admission_claims) = 'object'),
  credential_version INTEGER NOT NULL DEFAULT 0 CHECK (credential_version >= 0),
  authorization_epoch INTEGER NOT NULL DEFAULT 0 CHECK (authorization_epoch >= 0),
  UNIQUE (issuer, subject)
) STRICT;

CREATE TABLE credentials (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL CHECK (length(key_id) BETWEEN 1 AND 64),
  nonce TEXT NOT NULL CHECK (length(nonce) = 16),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 24 AND 5484),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE TABLE app_grants (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_grant_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK (json_type(scopes) = 'array'),
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 0),
  revoked_at INTEGER
) STRICT;

CREATE INDEX app_grants_account ON app_grants (account_id, credential_version, authorization_epoch) WHERE revoked_at IS NULL;

CREATE TABLE browser_sessions (
  session_hash TEXT PRIMARY KEY NOT NULL CHECK (length(session_hash) = 64 AND session_hash NOT GLOB '*[^0-9a-f]*'),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL CHECK (length(csrf_hash) = 64 AND csrf_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE login_transactions (
  state_hash TEXT PRIMARY KEY NOT NULL CHECK (length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
  browser_hash TEXT NOT NULL CHECK (length(browser_hash) = 64 AND browser_hash NOT GLOB '*[^0-9a-f]*'),
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  continuation TEXT,
  expires_at INTEGER NOT NULL
) STRICT;
