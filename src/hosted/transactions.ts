import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { hashOpaqueId } from "./crypto.js";
import type { Account, CredentialEnvelope } from "./store.js";

const onboarding = `FROM pending_authorizations p
  JOIN browser_sessions s ON s.csrf_hash=p.session_csrf_hash
  JOIN accounts a ON a.id=s.account_id AND a.credential_version=p.onboarding_version
  WHERE p.id_hash=? AND p.session_csrf_hash=? AND a.id=? AND p.expires_at>unixepoch()
    AND s.expires_at>unixepoch('subsec')*1000 AND NOT EXISTS (SELECT 1 FROM credentials c WHERE c.account_id=a.id)`;

export function transactions(db: D1Database) {
  return {
    async start(request: AuthRequest, session: string | null) {
      const id = crypto.randomUUID();
      await db.batch([
        db.prepare("DELETE FROM pending_authorizations WHERE id_hash IN (SELECT id_hash FROM pending_authorizations WHERE expires_at <= unixepoch() LIMIT 32)"),
        db.prepare("INSERT INTO pending_authorizations (id_hash, request_json, session_csrf_hash, expires_at) VALUES (?, ?, ?, unixepoch()+600)")
          .bind(await hashOpaqueId(id), JSON.stringify(request), session),
      ]);
      return id;
    },
    async showOnboarding(id: string, session: string, account: Account) {
      const result = await db.prepare(`UPDATE pending_authorizations SET onboarding_version=? WHERE id_hash=? AND session_csrf_hash=?
        AND expires_at>unixepoch() AND (onboarding_version IS NULL OR onboarding_version=?) AND EXISTS (
          SELECT 1 FROM accounts WHERE id=? AND credential_version=? AND NOT EXISTS (SELECT 1 FROM credentials WHERE account_id=accounts.id)
        )`).bind(account.credentialVersion, await hashOpaqueId(id), session, account.credentialVersion, account.id, account.credentialVersion).run();
      return result.meta.changes === 1;
    },
    async onboardingVersion(id: string, session: string, accountId: string) {
      return db.withSession("first-primary").prepare("SELECT p.onboarding_version " + onboarding)
        .bind(await hashOpaqueId(id), session, accountId).first<number>("onboarding_version");
    },
    async connect(id: string, session: string, accountId: string, envelope: CredentialEnvelope) {
      const { keyId, nonce, ciphertext, version } = envelope;
      const [inserted] = await db.batch([
        db.prepare(`INSERT INTO credentials (account_id, key_id, nonce, ciphertext, version)
          SELECT a.id, ?, ?, ?, ? ${onboarding} AND p.onboarding_version=?`)
          .bind(keyId, nonce, ciphertext, version, await hashOpaqueId(id), session, accountId, version - 1),
        db.prepare(`UPDATE accounts SET credential_version=? WHERE id=? AND credential_version=?
          AND EXISTS (SELECT 1 FROM credentials WHERE account_id=accounts.id AND version=?)`)
          .bind(version, accountId, version - 1, version),
      ]);
      return inserted.meta.changes === 1;
    },
    async bindLogin(id: string, session: string) {
      await db.prepare("UPDATE pending_authorizations SET session_csrf_hash=? WHERE id_hash=? AND session_csrf_hash IS NULL AND expires_at > unixepoch()")
        .bind(session, await hashOpaqueId(id)).run();
    },
    async resume(id: string, session: string, consume: boolean): Promise<AuthRequest | null> {
      const query = consume
        ? "DELETE FROM pending_authorizations WHERE id_hash=? AND session_csrf_hash=? AND expires_at > unixepoch() RETURNING request_json"
        : "SELECT request_json FROM pending_authorizations WHERE id_hash=? AND session_csrf_hash=? AND expires_at > unixepoch()";
      const row = await db.withSession("first-primary").prepare(query).bind(await hashOpaqueId(id), session).first<string>("request_json");
      return row === null ? null : JSON.parse(row);
    },
    async snapshot(handle: string, session: string, account: Account, label: string) {
      await db.batch([
        db.prepare("DELETE FROM consent_snapshots WHERE handle_hash IN (SELECT handle_hash FROM consent_snapshots WHERE expires_at <= unixepoch() LIMIT 32)"),
        db.prepare("INSERT INTO consent_snapshots VALUES (?, ?, ?, ?, ?, ?, unixepoch()+600)")
          .bind(await hashOpaqueId(handle), session, account.id, account.credentialVersion, account.authorizationEpoch, label.slice(0, 256)),
      ]);
    },
    async consume(handle: string, session: string, accountId: string) {
      return db.prepare(`DELETE FROM consent_snapshots WHERE handle_hash=? AND session_csrf_hash=? AND account_id=? AND expires_at > unixepoch()
        RETURNING credential_version AS credentialVersion, authorization_epoch AS authorizationEpoch, client_label AS label`)
        .bind(await hashOpaqueId(handle), session, accountId).first<{ credentialVersion: number; authorizationEpoch: number; label: string }>();
    },
  };
}
