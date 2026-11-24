import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptCredential, encryptCredential, hashOpaqueId } from "../../src/hosted/crypto.js";
import { createStore, type Account, type AppGrant, type Identity } from "../../src/hosted/store.js";
import { fakeEncryption } from "./fixtures.js";
import { resetHostedDb } from "./setup.js";

const identity = (subject: string): Identity => ({
  issuer: "https://id.example.invalid",
  subject,
  admissionClaims: { hd: "team.example.invalid" },
});
const credential = "fake-key-for-store-test";

const grant = (account: Account, version: number): AppGrant => ({
  id: `grant-${account.id}`,
  accountId: account.id,
  providerGrantId: `provider-${account.id}`,
  clientId: "test-client",
  scopes: ["read"],
  credentialVersion: version,
  authorizationEpoch: account.authorizationEpoch,
  revokedAt: null,
});

async function connected(store: ReturnType<typeof createStore>, subject: string) {
  const account = await store.getOrCreateAccount(identity(subject));
  const envelope = await encryptCredential(credential, account.id, 1, fakeEncryption());
  expect(await store.putCredential(account.id, envelope, 0)).toBe(true);
  return { account, envelope, record: grant(account, 1) };
}

beforeEach(resetHostedDb);

describe("accounts and encrypted credentials", () => {
  it("keys accounts by the exact issuer and subject, not an email, even on concurrent sign-ins", async () => {
    const store = createStore(env.DB);
    const firstIdentity = { ...identity("first"), email: "same@example.invalid" };
    const secondIdentity = { ...identity("second"), email: firstIdentity.email };
    const [first, duplicate, second, otherIssuer] = await Promise.all([
      store.getOrCreateAccount(firstIdentity),
      store.getOrCreateAccount(firstIdentity),
      store.getOrCreateAccount(secondIdentity),
      store.getOrCreateAccount({ ...firstIdentity, issuer: "https://other.example.invalid" }),
    ]);
    expect(first.id).toBe(duplicate.id);
    expect(new Set([first.id, second.id, otherIssuer.id]).size).toBe(3);
    expect(await store.getAccount(first.id)).toEqual({
      id: first.id, identity: identity("first"), authorizationEpoch: 0, credentialVersion: 0,
    });
  });

  it("refreshes only the persisted signed admission claim when the same identity signs in again", async () => {
    const store = createStore(env.DB);
    const { account } = await connected(store, "first");
    const updated = { ...identity("first"), admissionClaims: { hd: "new-team.example.invalid" } };
    expect(await store.getOrCreateAccount(updated)).toEqual({
      ...account, identity: updated, credentialVersion: 1,
    });
    expect(await store.getAccount(account.id)).toMatchObject({ identity: updated });
  });

  it("rejects oversized or nonscalar identity attributes rather than storing them", async () => {
    const store = createStore(env.DB);
    for (const attributes of [
      { hd: "a".repeat(257) },
      { hd: ["team.example.invalid"] },
      { hd: "team.example.invalid", extra: "unneeded" },
    ]) {
      await expect(store.getOrCreateAccount({ ...identity("bad"), admissionClaims: attributes })).rejects.toThrow(/^Invalid identity$/);
    }
    expect(await env.DB.prepare("SELECT count(*) AS count FROM accounts").first("count")).toBe(0);
  });

  it("stores only the encrypted credential envelope and returns it for an authorized grant", async () => {
    const store = createStore(env.DB);
    const { account, envelope, record } = await connected(store, "first");
    expect(await store.createGrant(record, 1, 0)).toBe(true);
    const authorized = await store.getAuthorizedCredential(account.id, record.id, 1, 0);
    expect(authorized).toEqual({ account: { ...account, credentialVersion: 1 }, credential: envelope });
    expect(await decryptCredential(authorized!.credential, account.id, fakeEncryption())).toBe(credential);

    const rows = await env.DB.prepare("SELECT * FROM credentials").all();
    expect(rows.results).toEqual([{
      account_id: account.id, key_id: "v1", nonce: envelope.nonce, ciphertext: envelope.ciphertext, version: 1,
    }]);
    const stored = await Promise.all(["accounts", "app_grants", "browser_sessions", "login_transactions"].map((table) =>
      env.DB.prepare(`SELECT * FROM ${table}`).all(),
    ));
    expect(JSON.stringify([rows, ...stored])).not.toContain(credential);
  });

  it("rejects wrong next versions and allows only one concurrent replacement for the same generation", async () => {
    const store = createStore(env.DB);
    const { account, record } = await connected(store, "first");
    expect(await store.createGrant(record, 1, 0)).toBe(true);
    const skipped = await encryptCredential("fake-skipped", account.id, 3, fakeEncryption());
    expect(await store.putCredential(account.id, skipped, 1)).toBe(false);
    const [first, second] = await Promise.all([
      encryptCredential("fake-replacement-a", account.id, 2, fakeEncryption()),
      encryptCredential("fake-replacement-b", account.id, 2, fakeEncryption()),
    ]);
    const results = await Promise.all([store.putCredential(account.id, first, 1), store.putCredential(account.id, second, 1)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.getAuthorizedCredential(account.id, record.id, 1, 0)).toBeNull();
    const replacementGrant = { ...record, id: "fresh-grant", providerGrantId: "fresh-provider", credentialVersion: 2 };
    expect(await store.createGrant(replacementGrant, 2, 0)).toBe(true);
    expect((await store.getAuthorizedCredential(account.id, replacementGrant.id, 2, 0))?.credential)
      .toEqual(results[0] ? first : second);
  });

  it("keeps the generation after physical deletion, rejecting old grants and a stale reconnect", async () => {
    const store = createStore(env.DB);
    const { account, envelope, record } = await connected(store, "first");
    expect(await store.createGrant(record, 1, 0)).toBe(true);
    expect(await store.deleteCredential(account.id)).toBe(true);
    expect(await store.deleteCredential(account.id)).toBe(false);
    expect(await env.DB.prepare("SELECT * FROM credentials").first()).toBeNull();
    expect(await store.getAccount(account.id)).toMatchObject({ credentialVersion: 2 });
    expect(await store.getAuthorizedCredential(account.id, record.id, 1, 0)).toBeNull();
    expect(await store.putCredential(account.id, envelope, 0)).toBe(false);
    const reconnected = await encryptCredential("fake-new-key", account.id, 3, fakeEncryption());
    expect(await store.putCredential(account.id, reconnected, 2)).toBe(true);
    expect(await store.getAuthorizedCredential(account.id, record.id, 1, 0)).toBeNull();
  });
});

describe("grant authorization", () => {
  it("only reads, lists and revokes live grants for their owner", async () => {
    const store = createStore(env.DB);
    const { account: first, record } = await connected(store, "first");
    const { account: second, record: other } = await connected(store, "second");
    expect(await store.createGrant(record, 1, 0)).toBe(true);
    expect(await store.createGrant(other, 1, 0)).toBe(true);
    expect(await store.listGrants(first.id)).toEqual([record]);
    expect(await store.listGrants(second.id)).toEqual([other]);
    expect(await store.getAuthorizedCredential(second.id, record.id, 1, 0)).toBeNull();
    expect(await store.getAuthorizedCredential(first.id, record.id, 2, 0)).toBeNull();
    expect(await store.getAuthorizedCredential(first.id, record.id, 1, 1)).toBeNull();
    expect(await store.revokeGrant(second.id, record.id)).toBe(false);
    expect(await store.getAuthorizedCredential(first.id, record.id, 1, 0)).not.toBeNull();
    expect(await store.revokeGrant(first.id, record.id)).toBe(true);
    expect(await store.revokeGrant(first.id, record.id)).toBe(false);
    expect(await store.listGrants(first.id)).toEqual([]);
    expect(await store.getAuthorizedCredential(first.id, record.id, 1, 0)).toBeNull();
    expect(await store.getAuthorizedCredential(second.id, other.id, 1, 0)).not.toBeNull();
  });

  it("cannot leave stale consent live when replacement and revocation race", async () => {
    const store = createStore(env.DB);
    const { account, record } = await connected(store, "first");
    expect(await store.createGrant(record, 1, 0)).toBe(true);
    const stale = { ...record, id: "stale-grant", providerGrantId: "stale-provider" };
    const replacement = await encryptCredential("fake-new-key", account.id, 2, fakeEncryption());
    const [replaced] = await Promise.all([
      store.putCredential(account.id, replacement, 1),
      store.revokeGrant(account.id, record.id),
      store.createGrant(stale, 1, 0),
    ]);
    expect(replaced).toBe(true);
    expect(await store.createGrant({ ...stale, id: "later", providerGrantId: "later-provider" }, 1, 0)).toBe(false);
    expect(await store.getAuthorizedCredential(account.id, stale.id, 1, 0)).toBeNull();
    expect(await store.getAuthorizedCredential(account.id, record.id, 1, 0)).toBeNull();
    expect(await store.listGrants(account.id)).toEqual([]);
  });

  it("disconnects all old grants by epoch without deleting the credential or affecting another account", async () => {
    const store = createStore(env.DB);
    const { account, record, envelope } = await connected(store, "first");
    const { account: otherAccount, record: other } = await connected(store, "second");
    expect(await store.createGrant(record, 1, 0)).toBe(true);
    expect(await store.createGrant(other, 1, 0)).toBe(true);
    await Promise.all([store.disconnectAll(account.id), store.disconnectAll(account.id)]);
    expect(await store.getAccount(account.id)).toMatchObject({ credentialVersion: 1, authorizationEpoch: 2 });
    expect(await store.listGrants(account.id)).toEqual([]);
    expect(await store.getAuthorizedCredential(account.id, record.id, 1, 0)).toBeNull();
    expect(await store.getAuthorizedCredential(otherAccount.id, other.id, 1, 0)).not.toBeNull();
    const fresh = { ...record, id: "fresh-grant", providerGrantId: "fresh-provider", authorizationEpoch: 2 };
    expect(await store.createGrant(fresh, 1, 0)).toBe(false);
    expect(await store.createGrant({ ...fresh, authorizationEpoch: 0 }, 1, 0)).toBe(false);
    expect(await store.createGrant(fresh, 1, 2)).toBe(true);
    expect((await store.getAuthorizedCredential(account.id, fresh.id, 1, 2))?.credential).toEqual(envelope);
  });

  it("opens a new first-primary D1 session for each authorization read", async () => {
    const store = createStore(env.DB);
    const { account, record } = await connected(store, "first");
    expect(await store.createGrant(record, 1, 0)).toBe(true);
    const withSession = vi.fn((constraint: D1SessionConstraint) => env.DB.withSession(constraint));
    const traced = createStore(new Proxy(env.DB, {
      get(target, property) {
        if (property === "withSession") return withSession;
        return Reflect.get(target, property, target);
      },
    }));
    expect(await traced.getAuthorizedCredential(account.id, record.id, 1, 0)).not.toBeNull();
    expect(await store.revokeGrant(account.id, record.id)).toBe(true);
    expect(await traced.getAuthorizedCredential(account.id, record.id, 1, 0)).toBeNull();
    expect(withSession.mock.calls).toEqual([["first-primary"], ["first-primary"]]);
  });
});

describe("browser state", () => {
  it("hashes opaque session IDs and never returns expired or deleted sessions", async () => {
    const store = createStore(env.DB);
    const { id } = await store.getOrCreateAccount(identity("first"));
    const sessionId = "test-browser-session";
    const session = { accountId: id, csrfHash: await hashOpaqueId("test-csrf"), expiresAt: Date.now() + 60_000 };
    await store.createSession(sessionId, session);
    expect(await store.getSession(sessionId)).toEqual(session);
    expect(await env.DB.prepare("SELECT session_hash FROM browser_sessions").first("session_hash")).toBe(await hashOpaqueId(sessionId));
    expect(await store.getSession(await hashOpaqueId(sessionId))).toBeNull();
    await store.createSession("test-expired-session", { ...session, expiresAt: Date.now() - 1 });
    expect(await store.getSession("test-expired-session")).toBeNull();
    await store.deleteSession(sessionId);
    expect(await store.getSession(sessionId)).toBeNull();
  });

  it("atomically consumes a login only once AND only with the matching browser binding", async () => {
    const store = createStore(env.DB);
    const login = {
      stateHash: await hashOpaqueId("test-authorization-state"),
      browserHash: await hashOpaqueId("test-browser-binding"),
      verifier: "test-pkce-verifier",
      nonce: "test-login-nonce",
      continuation: "opaque-consent-reference",
      expiresAt: Date.now() + 60_000,
    };
    await store.createLogin(login);
    expect(await store.consumeLogin(login.stateHash, await hashOpaqueId("wrong-browser"))).toBeNull();
    expect(await store.consumeLogin(await hashOpaqueId("wrong-state"), login.browserHash)).toBeNull();
    expect(await store.consumeLogin("test-authorization-state", login.browserHash)).toBeNull();
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      store.consumeLogin(login.stateHash, login.browserHash),
    ));
    expect(results.filter(Boolean)).toEqual([login]);
    expect(await store.consumeLogin(login.stateHash, login.browserHash)).toBeNull();
  });

  it("does not consume an expired login even when both hashes match", async () => {
    const store = createStore(env.DB);
    const login = {
      stateHash: await hashOpaqueId("test-expired-state"),
      browserHash: await hashOpaqueId("test-browser-binding"),
      verifier: "test-pkce-verifier",
      nonce: "test-login-nonce",
      continuation: null,
      expiresAt: Date.now() - 1,
    };
    await store.createLogin(login);
    expect(await store.consumeLogin(login.stateHash, login.browserHash)).toBeNull();
    expect(await env.DB.prepare("SELECT state_hash FROM login_transactions").first("state_hash")).toBe(login.stateHash);
  });

  it("uses the database clock to reject a session that looks live to the Worker", async () => {
    const store = createStore(env.DB);
    const { id } = await store.getOrCreateAccount(identity("first"));
    const sessionId = "test-stale-clock-session";
    const expiresAt = 1_000;
    await store.createSession(sessionId, { accountId: id, csrfHash: await hashOpaqueId("test-csrf"), expiresAt });

    const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAt - 1);
    try {
      expect(await store.getSession(sessionId)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it("uses the database clock to reject and preserve a login that looks live to the Worker", async () => {
    const store = createStore(env.DB);
    const login = {
      stateHash: await hashOpaqueId("test-stale-clock-state"),
      browserHash: await hashOpaqueId("test-browser-binding"),
      verifier: "test-pkce-verifier",
      nonce: "test-login-nonce",
      continuation: null,
      expiresAt: 1_000,
    };
    await store.createLogin(login);

    const clock = vi.spyOn(Date, "now").mockReturnValue(login.expiresAt - 1);
    try {
      expect(await store.consumeLogin(login.stateHash, login.browserHash)).toBeNull();
    } finally {
      clock.mockRestore();
    }
    expect(await env.DB.prepare("SELECT state_hash FROM login_transactions").first("state_hash")).toBe(login.stateHash);
  });
});
