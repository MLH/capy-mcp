import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { hashOpaqueId } from "./crypto.js";
import type { Account } from "./store.js";

export function transactions(db: D1Database) {
  return {
    async start(request: AuthRequest, session: string | null) {
      const id = crypto.randomUUID();
      await db.batch([
        db.prepare("DELETE FROM pending_authorizations WHERE id_hash IN (SELECT id_hash FROM pending_authorizations WHERE expires_at <= unixepoch() LIMIT 32)"),
        db.prepare("INSERT INTO pending_authorizations VALUES (?, ?, ?, unixepoch()+600)")
          .bind(await hashOpaqueId(id), JSON.stringify(request), session),
      ]);
      return id;
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
