import { hashOpaqueId } from "./crypto.js";

export interface Identity {
  issuer: string;
  subject: string;
  admissionClaims: Readonly<Record<string, unknown>>;
}

export interface Account {
  id: string;
  identity: Identity;
  authorizationEpoch: number;
  credentialVersion: number;
}

export interface CredentialEnvelope {
  keyId: string;
  nonce: string;
  ciphertext: string;
  version: number;
}

export interface AppGrant {
  id: string;
  accountId: string;
  providerGrantId: string;
  clientId: string;
  scopes: readonly string[];
  credentialVersion: number;
  authorizationEpoch: number;
  revokedAt: number | null;
}

export type AccountClient = Pick<AppGrant, "id" | "scopes"> & { label: string; createdAt: number | null };

export interface BrowserSession {
  accountId: string;
  csrfHash: string;
  expiresAt: number;
}

export interface LoginTransaction {
  stateHash: string;
  browserHash: string;
  verifier: string;
  nonce: string;
  continuation: string | null;
  expiresAt: number;
}

export const MAX_ISSUER_LENGTH = 2_048;

export function isOidcSubject(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,255}$/.test(value);
}

export function isAdmissionString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}

type AccountRow = Omit<Account, "identity"> & { issuer: string; subject: string; admissionClaims: string };
type GrantRow = Omit<AppGrant, "scopes"> & { scopes: string };

const accountColumns = `accounts.id, accounts.issuer, accounts.subject, accounts.admission_claims AS admissionClaims,
  accounts.credential_version AS credentialVersion, accounts.authorization_epoch AS authorizationEpoch`;
const loginColumns = `state_hash AS stateHash, browser_hash AS browserHash, verifier, nonce, continuation, expires_at AS expiresAt`;
const databaseTimeMs = "unixepoch('now') * 1000 + CAST(substr(strftime('%f', 'now'), 4) AS INTEGER)";

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    identity: { issuer: row.issuer, subject: row.subject, admissionClaims: JSON.parse(row.admissionClaims) },
    credentialVersion: row.credentialVersion,
    authorizationEpoch: row.authorizationEpoch,
  };
}

function identityValues({ issuer, subject, admissionClaims }: Identity) {
  const claims = Object.entries(admissionClaims);
  if (!issuer || issuer.length > MAX_ISSUER_LENGTH || !isOidcSubject(subject) ||
      claims.length > 1 || claims.some(([name, value]) => !isAdmissionString(name) || !isAdmissionString(value))) {
    throw new Error("Invalid identity");
  }
  return { issuer, subject, claims: JSON.stringify(Object.fromEntries(claims)) };
}

export function createStore(db: D1Database) {
  const primary = (sql: string) => db.withSession("first-primary").prepare(sql);

  return {
    async getOrCreateAccount(identity: Identity): Promise<Account> {
      const { issuer, subject, claims } = identityValues(identity);
      const row = await db.prepare(`
        INSERT INTO accounts (id, issuer, subject, admission_claims) VALUES (?, ?, ?, ?)
        ON CONFLICT (issuer, subject) DO UPDATE SET admission_claims = excluded.admission_claims
        RETURNING ${accountColumns}
      `).bind(crypto.randomUUID(), issuer, subject, claims).first<AccountRow>();
      if (!row) throw new Error("Account write failed");
      return toAccount(row);
    },

    async updateExistingAdmission(identity: Identity): Promise<void> {
      const { issuer, subject, claims } = identityValues(identity);
      await db.prepare("UPDATE accounts SET admission_claims = ? WHERE issuer = ? AND subject = ?")
        .bind(claims, issuer, subject).run();
    },

    async getAccount(id: string): Promise<Account | null> {
      const row = await primary(`SELECT ${accountColumns} FROM accounts WHERE id = ?`).bind(id).first<AccountRow>();
      return row && toAccount(row);
    },

    async putCredential(accountId: string, envelope: CredentialEnvelope, expectedVersion: number): Promise<boolean> {
      const { keyId, nonce, ciphertext, version } = envelope;
      if (!Number.isSafeInteger(version) || version < 1 || version !== expectedVersion + 1) return false;
      const [upsert] = await db.batch([
        db.prepare(`
          INSERT INTO credentials (account_id, key_id, nonce, ciphertext, version)
          SELECT id, ?, ?, ?, ? FROM accounts WHERE id = ? AND credential_version = ?
          ON CONFLICT (account_id) DO UPDATE SET
            key_id = excluded.key_id, nonce = excluded.nonce, ciphertext = excluded.ciphertext, version = excluded.version
        `).bind(keyId, nonce, ciphertext, version, accountId, expectedVersion),
        db.prepare(`
          UPDATE accounts SET credential_version = ?
          WHERE id = ? AND credential_version = ? AND EXISTS (
            SELECT 1 FROM credentials WHERE account_id = accounts.id AND version = ?
          )
        `).bind(version, accountId, expectedVersion, version),
      ]);
      return upsert.meta.changes === 1;
    },

    async deleteCredential(accountId: string): Promise<boolean> {
      const [, deleted] = await db.batch([
        db.prepare(`
          UPDATE accounts SET credential_version = credential_version + 1
          WHERE id = ? AND EXISTS (SELECT 1 FROM credentials WHERE account_id = accounts.id)
        `).bind(accountId),
        db.prepare("DELETE FROM credentials WHERE account_id = ?").bind(accountId),
      ]);
      return deleted.meta.changes === 1;
    },

    async createGrant(record: AppGrant, expectedCredentialVersion: number, expectedEpoch: number, clientLabel?: string): Promise<boolean> {
      if (record.credentialVersion !== expectedCredentialVersion ||
          record.authorizationEpoch !== expectedEpoch || record.revokedAt !== null) return false;
      const label = clientLabel?.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 256) || null;
      const result = await db.prepare(`
        INSERT INTO app_grants (id, account_id, provider_grant_id, client_id, scopes, credential_version, authorization_epoch, created_at, client_label)
        SELECT ?, accounts.id, ?, ?, ?, accounts.credential_version, accounts.authorization_epoch, ${databaseTimeMs}, ?
        FROM accounts
        JOIN credentials ON credentials.account_id = accounts.id AND credentials.version = accounts.credential_version
        WHERE accounts.id = ? AND accounts.credential_version = ? AND accounts.authorization_epoch = ?
      `).bind(record.id, record.providerGrantId, record.clientId, JSON.stringify(record.scopes), label,
        record.accountId, expectedCredentialVersion, expectedEpoch).run();
      return result.meta.changes === 1;
    },

    async getAccountConnection(accountId: string): Promise<{ connected: boolean; clients: AccountClient[] }> {
      type ConnectionRow = { connected: number; id: string | null; label: string | null; scopes: string | null; createdAt: number | null };
      const { results } = await primary(`
        SELECT credentials.account_id IS NOT NULL AS connected, app_grants.id, COALESCE(app_grants.client_label, app_grants.client_id) AS label,
          app_grants.scopes, app_grants.created_at AS createdAt
        FROM accounts
        LEFT JOIN credentials ON credentials.account_id = accounts.id AND credentials.version = accounts.credential_version
        LEFT JOIN app_grants ON app_grants.account_id = credentials.account_id
          AND app_grants.credential_version = credentials.version AND app_grants.authorization_epoch = accounts.authorization_epoch
          AND app_grants.revoked_at IS NULL
        WHERE accounts.id = ? ORDER BY app_grants.created_at DESC, app_grants.id
      `).bind(accountId).all<ConnectionRow>();
      const clients: AccountClient[] = [];
      for (const { id, label, scopes, createdAt } of results) {
        if (id !== null && label !== null && scopes !== null) clients.push({ id, label, scopes: JSON.parse(scopes), createdAt });
      }
      return { connected: results[0]?.connected === 1, clients };
    },

    async attachProviderGrant(accountId: string, appGrantId: string, providerId: string, clientId: string): Promise<boolean> {
      const result = await db.prepare(`UPDATE app_grants SET provider_grant_id=? WHERE account_id=? AND id=? AND client_id=?
        AND provider_grant_id IN (?, ?) AND revoked_at IS NULL`)
        .bind(providerId, accountId, appGrantId, clientId, "pending:" + appGrantId, providerId).run();
      return result.meta.changes === 1;
    },

    async getAuthorizedCredential(accountId: string, grantId: string, version: number, epoch: number,
      token?: { clientId: string; scopes: string[]; providerGrantId?: string }):
      Promise<{ account: Account; credential: CredentialEnvelope } | null> {
      const row = await primary(`
        SELECT ${accountColumns}, credentials.key_id AS keyId, credentials.nonce, credentials.ciphertext, credentials.version
        FROM accounts
        JOIN credentials ON credentials.account_id = accounts.id AND credentials.version = accounts.credential_version
        JOIN app_grants ON app_grants.account_id = accounts.id
          AND app_grants.credential_version = credentials.version AND app_grants.authorization_epoch = accounts.authorization_epoch
        WHERE accounts.id = ? AND app_grants.id = ? AND credentials.version = ?
          AND accounts.authorization_epoch = ? AND app_grants.revoked_at IS NULL
          AND (? IS NULL OR app_grants.client_id = ?) AND (? IS NULL OR app_grants.provider_grant_id = ?)
          AND NOT EXISTS (SELECT value FROM json_each(?) EXCEPT SELECT value FROM json_each(app_grants.scopes))
      `).bind(accountId, grantId, version, epoch, token?.clientId ?? null, token?.clientId ?? null,
        token?.providerGrantId ?? null, token?.providerGrantId ?? null, JSON.stringify(token?.scopes ?? [])).first<AccountRow & CredentialEnvelope>();
      if (!row) return null;
      const { keyId, nonce, ciphertext, version: storedVersion } = row;
      return { account: toAccount(row), credential: { keyId, nonce, ciphertext, version: storedVersion } };
    },

    async listGrants(accountId: string): Promise<AppGrant[]> {
      const { results } = await primary(`
        SELECT app_grants.id, account_id AS accountId, provider_grant_id AS providerGrantId, client_id AS clientId,
          scopes, app_grants.credential_version AS credentialVersion, app_grants.authorization_epoch AS authorizationEpoch,
          revoked_at AS revokedAt
        FROM app_grants
        JOIN accounts ON accounts.id = app_grants.account_id AND accounts.credential_version = app_grants.credential_version
          AND accounts.authorization_epoch = app_grants.authorization_epoch
        WHERE app_grants.account_id = ? AND revoked_at IS NULL ORDER BY app_grants.id
      `).bind(accountId).all<GrantRow>();
      return results.map((row) => ({ ...row, scopes: JSON.parse(row.scopes) }));
    },

    async revokeGrant(accountId: string, grantId: string): Promise<boolean> {
      const result = await db.prepare(`
        UPDATE app_grants SET revoked_at = ? WHERE account_id = ? AND id = ? AND revoked_at IS NULL
      `).bind(Date.now(), accountId, grantId).run();
      return result.meta.changes === 1;
    },

    async cleanupRevoked(accountId: string, revoke: (id: string, user: string) => Promise<void>) {
      for (;;) {
        const { results } = await primary(`SELECT g.id, provider_grant_id AS provider FROM app_grants g JOIN accounts a ON a.id=g.account_id
          WHERE a.id=? AND instr(provider_grant_id, ':')=0 AND
            (g.revoked_at IS NOT NULL OR g.authorization_epoch != a.authorization_epoch OR g.credential_version != a.credential_version)
          LIMIT 8`).bind(accountId).all<{ id: string; provider: string }>();
        if (!results.length) return;
        const done = await Promise.allSettled(results.map(async ({ id, provider }) => {
          await revoke(provider, accountId);
          await db.prepare("UPDATE app_grants SET provider_grant_id=? WHERE account_id=? AND id=? AND provider_grant_id=?")
            .bind("revoked:" + id, accountId, id, provider).run();
        }));
        if (done.some(r => r.status === "rejected")) return;
      }
    },

    async disconnectAll(accountId: string): Promise<boolean> {
      const result = await db.prepare(`
        UPDATE accounts SET authorization_epoch = authorization_epoch + 1 WHERE id = ?
      `).bind(accountId).run();
      return result.meta.changes === 1;
    },

    async createSession(id: string, session: BrowserSession): Promise<void> {
      await db.prepare(`
        INSERT INTO browser_sessions (session_hash, account_id, csrf_hash, expires_at) VALUES (?, ?, ?, ?)
      `).bind(await hashOpaqueId(id), session.accountId, session.csrfHash, session.expiresAt).run();
    },

    async getSession(id: string): Promise<BrowserSession | null> {
      return primary(`
        SELECT account_id AS accountId, csrf_hash AS csrfHash, expires_at AS expiresAt
        FROM browser_sessions WHERE session_hash = ? AND expires_at > (${databaseTimeMs})
      `).bind(await hashOpaqueId(id)).first<BrowserSession>();
    },

    async deleteSession(id: string): Promise<void> {
      await db.prepare("DELETE FROM browser_sessions WHERE session_hash = ?").bind(await hashOpaqueId(id)).run();
    },

    async createLogin({ stateHash, browserHash, verifier, nonce, continuation, expiresAt }: LoginTransaction): Promise<void> {
      await db.prepare(`
        INSERT INTO login_transactions (state_hash, browser_hash, verifier, nonce, continuation, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(stateHash, browserHash, verifier, nonce, continuation, expiresAt).run();
    },

    async consumeLogin(stateHash: string, browserHash: string): Promise<LoginTransaction | null> {
      return db.prepare(`
        DELETE FROM login_transactions WHERE state_hash = ? AND browser_hash = ? AND expires_at > (${databaseTimeMs})
        RETURNING ${loginColumns}
      `).bind(stateHash, browserHash).first<LoginTransaction>();
    },
  };
}
