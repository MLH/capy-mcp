import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { handleAccount, validateCapyKey } from "../../src/hosted/account.js";
import { decryptCredential, encryptCredential, hashOpaqueId } from "../../src/hosted/crypto.js";
import { createStore, type Account, type AppGrant } from "../../src/hosted/store.js";
import { fakeEncryption, hostedEnv } from "./fixtures.js";
import { resetHostedDb } from "./setup.js";

const origin = "https://mcp.example.invalid";
const env = hostedEnv();
const store = createStore(env.DB);
const oldKey = "fake-old-capy-key";
const newKey = "fake-new-capy-key";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function identity(subject: string, domain = "team.example.invalid") {
  return { issuer: env.OIDC_ISSUER, subject, admissionClaims: { hd: domain } };
}

async function signIn(subject = "account-owner", domain?: string) {
  const account = await store.getOrCreateAccount(identity(subject, domain));
  const session = "s" + crypto.randomUUID().replaceAll("-", "").padEnd(42, "s");
  const csrf = "c" + crypto.randomUUID().replaceAll("-", "").padEnd(42, "c");
  await store.createSession(session, { accountId: account.id, csrfHash: await hashOpaqueId(csrf), expiresAt: Date.now() + 60_000 });
  return { account, csrf, cookie: `__Host-capy-session=${session}; __Host-capy-csrf=${csrf}` };
}

async function connect(account: Account, key = oldKey) {
  expect(await store.putCredential(account.id,
    await encryptCredential(key, account.id, account.credentialVersion + 1, fakeEncryption()),
    account.credentialVersion)).toBe(true);
}

async function grant(account: Account, clientId = "Own MCP client", scopes = ["capy:read"], clientLabel?: string) {
  const record: AppGrant = {
    id: crypto.randomUUID(), accountId: account.id, providerGrantId: crypto.randomUUID(), clientId,
    credentialVersion: account.credentialVersion + 1, authorizationEpoch: account.authorizationEpoch,
    scopes, revokedAt: null,
  };
  expect(await store.createGrant(record, record.credentialVersion, record.authorizationEpoch, clientLabel)).toBe(true);
  return record;
}

function authorize(record: AppGrant) {
  return store.getAuthorizedCredential(record.accountId, record.id, record.credentialVersion, record.authorizationEpoch);
}

function get(path: string, cookie = "") {
  return handleAccount(new Request(origin + path, { headers: { Cookie: cookie } }), env);
}

function postRequest(path: string, cookie: string, fields: Record<string, string> | string, from: string | null = origin, signal?: AbortSignal) {
  const headers = new Headers({ Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" });
  if (from !== null) headers.set("Origin", from);
  return new Request(origin + path, {
    method: "POST", headers, body: typeof fields === "string" ? fields : new URLSearchParams(fields).toString(), signal,
  });
}

function post(path: string, cookie: string, fields: Record<string, string> | string, from?: string | null) {
  return handleAccount(postRequest(path, cookie, fields, from), env);
}

function fakeCapy(reply: () => Response | Promise<Response>) {
  const boundary = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toBe("https://api.capy.ai/api/v1/projects");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe("manual");
    return reply();
  });
  vi.stubGlobal("fetch", boundary);
  return boundary;
}

beforeEach(async () => {
  await resetHostedDb();
  fakeCapy(() => {
    throw new Error("Unexpected Capy request");
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("hosted account", () => {
  it("binds both ordinary forms and a removal confirmation to their rendered generations", async () => {
    const owner = await signIn();
    const version = async (path: string) => {
      const html = await (await get(path, owner.cookie)).text();
      const match = html.match(/name="generation" value="(\d+)"/);
      expect(match).not.toBeNull();
      return match![1];
    };
    fakeCapy(() => Response.json({ projects: [] }));
    const save = (generation: string) => post("/account/key", owner.cookie, { csrf: owner.csrf, key: newKey, generation });
    const remove = (generation: string) => post("/account/key/delete", owner.cookie, { csrf: owner.csrf, generation });
    const [first, second] = await Promise.all([version("/account"), version("/account")]);
    expect((await save(first)).status).toBe(303);
    expect((await save(second)).status).toBe(409);
    const confirmation = await version("/account?confirm=delete");
    expect((await remove(confirmation)).status).toBe(303);
    expect((await save(await version("/account"))).status).toBe(303);
    expect((await remove(confirmation)).status).toBe(409);
    expect((await store.getAccount(owner.account.id))?.credentialVersion).toBe(3);
    expect((await store.getAccountConnection(owner.account.id)).connected).toBe(true);
  });

  it.each(["", "&generation=", "&generation=-1", "&generation=1e0", "&generation=00", "&generation=9007199254740992", "&generation=0&generation=0"])(
    "rejects an absent or noncanonical generation before validation (%#)", async suffix => {
      const owner = await signIn();
      const body = new URLSearchParams({ csrf: owner.csrf, key: newKey }).toString() + suffix;
      for (const path of ["/account/key", "/account/key/delete"]) expect((await post(path, owner.cookie, body)).status).toBe(400);
      expect(fetch).not.toHaveBeenCalled();
    });

  it("rejects invented onboarding transactions before validating or writing a key", async () => {
    const owner = await signIn();
    fakeCapy(() => Response.json({ projects: [] }));
    const response = await post("/account/key?transaction=" + crypto.randomUUID(), owner.cookie, { csrf: owner.csrf, key: newKey });
    expect(response.status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.getAccountConnection(owner.account.id)).toEqual({ generation: 0, connected: false, clients: [] });
  });
  it("shows only sign-in to unauthenticated visitors and denies their writes", async () => {
    const page = await get("/account");
    expect(page.status).toBe(401);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(await page.text()).toContain('href="/auth/login"');
    const response = await post("/account/key", "", { key: newKey });
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("denies account reads and every account mutation after a signed admission change", async () => {
    const owner = await signIn();
    await connect(owner.account);
    const ownGrant = await grant(owner.account);
    await store.updateExistingAdmission(identity(owner.account.identity.subject, "withdrawn.example.invalid"));

    const page = await get("/account", owner.cookie);
    expect(page.status).toBe(403);
    const html = await page.text();
    expect(html.match(/<form[^>]*action="([^"]+)"/g)).toEqual(['<form method="post" action="/auth/logout"']);
    expect(html).not.toContain(ownGrant.clientId);
    for (const path of ["/account/key", "/account/key/delete", `/account/grants/${ownGrant.id}/revoke`, "/account/disconnect"]) {
      expect((await post(path, owner.cookie, { csrf: owner.csrf, key: newKey })).status).toBe(403);
    }
    expect(await authorize(ownGrant)).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses only session ownership for status, grants and credential writes", async () => {
    const [owner, other] = await Promise.all([signIn(), signIn("other-owner")]);
    await connect(other.account, "fake-other-capy-key");
    const otherGrant = await grant(other.account, "Other MCP client");
    const selector = { accountId: other.account.id, credentialId: other.account.id, grantId: otherGrant.id };

    const page = await get(`/account?${new URLSearchParams(selector)}`, owner.cookie);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("No Capy key connected");
    for (const privateValue of [...Object.values(selector), otherGrant.clientId]) expect(html).not.toContain(privateValue);

    expect((await post(`/account/grants/${otherGrant.id}/revoke`, owner.cookie, { csrf: owner.csrf })).status).toBe(404);
    expect((await get(`/account?confirm=revoke&grant=${otherGrant.id}`, owner.cookie)).status).toBe(404);
    expect((await post("/account/key/delete", owner.cookie, { csrf: owner.csrf, generation: "0", ...selector })).status).toBe(409);
    fakeCapy(() => Response.json({ projects: [] }));
    expect((await post("/account/key", owner.cookie, { csrf: owner.csrf, key: newKey, generation: "0", ...selector })).status).toBe(303);
    expect(await store.getAccount(owner.account.id)).toMatchObject({ credentialVersion: 1 });
    const authorized = await authorize(otherGrant);
    expect(authorized).not.toBeNull();
    expect(await decryptCredential(authorized!.credential, other.account.id, fakeEncryption())).toBe("fake-other-capy-key");
  });

  it.each([
    ["missing Origin", null, "valid", 403],
    ["forged Origin", "https://mcp.example.invalid.attacker.invalid", "valid", 403],
    ["missing CSRF", origin, "missing", 403],
    ["forged CSRF", origin, "forged", 403],
    ["duplicate CSRF", origin, "duplicate", 403],
    ["oversized body", origin, "oversized", 413],
  ])("rejects %s before touching Capy or storage", async (_case, from, variant, status) => {
    const owner = await signIn();
    const fields = new URLSearchParams({ key: newKey });
    if (variant !== "missing") fields.set("csrf", variant === "forged" ? "f".repeat(43) : owner.csrf);
    if (variant === "duplicate") fields.append("csrf", owner.csrf);
    if (variant === "oversized") fields.append("padding", "a".repeat(16_384));
    const response = await post("/account/key", owner.cookie, fields.toString(), from);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(newKey);
    expect(await store.getAccount(owner.account.id)).toMatchObject({ credentialVersion: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires POST for mutations and gets confirmation without changing state", async () => {
    const owner = await signIn();
    await connect(owner.account);
    const ownGrant = await grant(owner.account);
    for (const path of ["/account/key", "/account/key/delete", `/account/grants/${ownGrant.id}/revoke`, "/account/disconnect"]) {
      expect((await get(path, owner.cookie)).status).toBe(405);
    }
    const page = await get(`/account?confirm=revoke&grant=${ownGrant.id}`, owner.cookie);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`method="post" action="/account/grants/${ownGrant.id}/revoke"`);
    expect(html).toContain(`name="csrf" value="${owner.csrf}"`);
    for (const [kind, action] of [["delete", "/account/key/delete"], ["disconnect", "/account/disconnect"]]) {
      const confirm = await get(`/account?confirm=${kind}`, owner.cookie);
      expect(confirm.status).toBe(200);
      expect(await confirm.text()).toContain(`method="post" action="${action}"`);
    }
    expect(await authorize(ownGrant)).not.toBeNull();
  });

  it("escapes signed identity, client labels and scopes and never renders credential internals", async () => {
    const owner = await signIn("<script>alert('identity')</script>");
    await connect(owner.account);
    const ownGrant = await grant(owner.account, "opaque-client-id", ["capy:read", "<scope>"], '"><img src=x onerror=alert(1)>');
    const authorized = await authorize(ownGrant);
    expect(authorized).not.toBeNull();

    const page = await get("/account", owner.cookie);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(page.headers.get("Referrer-Policy")).toBe("strict-origin");
    expect(page.headers.get("Content-Security-Policy")).toMatch(/form-action 'self'(?:;|$)/);
    const html = await page.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;scope&gt;");
    expect(html).toContain("capy:read");
    expect(html).toMatch(/<time datetime="\d{4}-\d{2}-\d{2}T/);
    expect(html).toContain('type="password" name="key"');
    expect(html).toContain('method="post" action="/auth/logout"');
    expect(html).toContain(`name="csrf" value="${owner.csrf}"`);
    for (const privateValue of [
      "<script", "<img", "<scope>", oldKey, authorized!.credential.ciphertext, authorized!.credential.nonce,
      owner.account.id, ownGrant.providerGrantId, owner.cookie.split(";")[0].split("=")[1],
    ]) expect(html).not.toContain(privateValue);
    const confirm = await get(`/account?confirm=revoke&grant=${ownGrant.id}`, owner.cookie);
    expect(await confirm.text()).toContain("&lt;img");
  });

  it("falls back to the client ID when a display label contains only control characters", async () => {
    const owner = await signIn();
    await connect(owner.account);
    await grant(owner.account, "Fallback client ID", ["capy:read"], "\x00");
    const page = await get("/account", owner.cookie);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Fallback client ID");
  });

  it.each(["", "fake key with spaces", "fake\nkey", "A".repeat(4_097), "fake&key=duplicate"])(
    "rejects a missing, malformed, oversized or duplicated key before fetch (case %#)", async (key) => {
      const owner = await signIn();
      const body = key === "fake&key=duplicate"
        ? `csrf=${owner.csrf}&generation=0&key=${key}`
        : new URLSearchParams({ csrf: owner.csrf, generation: "0", key }).toString();
      const response = await post("/account/key", owner.cookie, body);
      expect(response.status).toBe(400);
      expect(await store.getAccount(owner.account.id)).toMatchObject({ credentialVersion: 0 });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403])("rejects a Capy %s without disclosing response data or replacing an existing key", async (status) => {
    const owner = await signIn();
    await connect(owner.account);
    const ownGrant = await grant(owner.account);
    const before = await authorize(ownGrant);
    const capy = fakeCapy(() => Response.json({ secret: newKey, principal: "fake-upstream-principal" }, { status }));
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");

    const result = await post("/account/key", owner.cookie, { csrf: owner.csrf, key: newKey, generation: "1" });
    expect(result.status).toBe(422);
    expect(result.headers.get("Location")).toBeNull();
    const body = await result.text();
    expect(body).not.toContain(newKey);
    expect(body).not.toContain("fake-upstream-principal");
    expect([log.mock.calls, warn.mock.calls, error.mock.calls]).toEqual([[], [], []]);
    expect(capy).toHaveBeenCalledTimes(1);
    expect(await authorize(ownGrant)).toEqual(before);
    expect(await store.getAccount(owner.account.id)).toMatchObject({ credentialVersion: 1 });
  });

  it("times out a stalled validation and leaves the old version authorized", async () => {
    const owner = await signIn();
    await connect(owner.account);
    const ownGrant = await grant(owner.account);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const started = deferred<void>();
    const capy = fakeCapy(() => {
      started.resolve();
      return new Promise(() => {});
    });
    const posted = post("/account/key", owner.cookie, { csrf: owner.csrf, key: newKey, generation: "1" });
    await Promise.race([
      started.promise,
      posted.then(() => { throw new Error("Key validation never called Capy"); }),
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await posted;
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain(newKey);
    expect(capy.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(await authorize(ownGrant)).not.toBeNull();
  });

  it("does not persist a validation abandoned by its HTTP request", async () => {
    const owner = await signIn();
    const controller = new AbortController();
    const capy = fakeCapy(() => {
      controller.abort();
      return Response.json({ projects: [] });
    });
    const result = await handleAccount(
      postRequest("/account/key", owner.cookie, { csrf: owner.csrf, key: newKey, generation: "0" }, origin, controller.signal), env,
    );
    expect(result.status).toBe(503);
    expect(capy.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(await store.getAccount(owner.account.id)).toMatchObject({ credentialVersion: 0 });
  });

  it("accepts one fixed read-only projects request and discards returned content", async () => {
    const capy = fakeCapy(() => Response.json({ projects: [{ displayName: "fake-private-project" }], next: "fake-cursor" }));
    await expect(validateCapyKey(newKey)).resolves.toBeUndefined();
    expect(capy).toHaveBeenCalledTimes(1);
    const headers = new Headers(capy.mock.calls[0][1]?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${newKey}`);
  });

  it("replaces and deletes the current envelope, and reconnect never reuses a grant version", async () => {
    const owner = await signIn();
    await connect(owner.account);
    const firstGrant = await grant(owner.account);
    const capy = fakeCapy(() => Response.json({ data: newKey }));
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const result = await post("/account/key?return=https://other.invalid", owner.cookie, { csrf: owner.csrf, key: newKey, generation: "1" });
    expect(result.status).toBe(303);
    expect(result.headers.get("Location")).toBe("/account");
    expect(await result.text()).toBe("");
    expect(JSON.stringify([...result.headers])).not.toContain(newKey);
    expect([log.mock.calls, warn.mock.calls, error.mock.calls]).toEqual([[], [], []]);
    expect(capy).toHaveBeenCalledTimes(1);
    expect(await authorize(firstGrant)).toBeNull();

    const credential = await env.DB.prepare("SELECT key_id AS keyId, nonce, ciphertext, version FROM credentials WHERE account_id = ?")
      .bind(owner.account.id).first<{ keyId: string; nonce: string; ciphertext: string; version: number }>();
    expect(credential).not.toBeNull();
    expect(credential?.version).toBe(2);
    expect(JSON.stringify(await env.DB.prepare("SELECT * FROM credentials").all())).not.toContain(newKey);
    expect(await decryptCredential(credential!, owner.account.id, fakeEncryption())).toBe(newKey);
    expect(await (await get("/account", owner.cookie)).text()).not.toContain(newKey);
    const secondGrant = await grant({ ...owner.account, credentialVersion: 1 });

    const deleted = await post("/account/key/delete", owner.cookie, { csrf: owner.csrf, generation: "2" });
    expect(deleted.status).toBe(303);
    expect(await authorize(secondGrant)).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM credentials").first<{ count: number }>())?.count).toBe(0);
    expect(await (await get("/account", owner.cookie)).text()).toContain("No Capy key connected");

    expect((await post("/account/key", owner.cookie, { csrf: owner.csrf, key: newKey, generation: "3" })).status).toBe(303);
    expect(await store.getAccount(owner.account.id)).toMatchObject({ credentialVersion: 4 });
    expect(await authorize(firstGrant)).toBeNull();
    expect(await authorize(secondGrant)).toBeNull();
  });

  it("does not let a slower validation overwrite a winning credential generation", async () => {
    const owner = await signIn();
    const started = deferred<void>();
    const validated = deferred<Response>();
    fakeCapy(() => {
      started.resolve();
      return validated.promise;
    });
    const pending = post("/account/key", owner.cookie, { csrf: owner.csrf, key: newKey, generation: "0" });
    await Promise.race([
      started.promise,
      pending.then(() => { throw new Error("Key validation never called Capy"); }),
    ]);
    await connect(owner.account);
    const winningGrant = await grant(owner.account);
    validated.resolve(Response.json({ projects: [] }));
    const result = await pending;
    expect(result.status).toBe(409);
    expect(await result.text()).not.toContain(newKey);
    const authorized = await authorize(winningGrant);
    expect(authorized).not.toBeNull();
    expect(await decryptCredential(authorized!.credential, owner.account.id, fakeEncryption())).toBe(oldKey);
  });

  it("revokes one grant and disconnects all in D1 without deleting the key or browser session", async () => {
    const owner = await signIn();
    await connect(owner.account);
    const one = await grant(owner.account, "First client");
    const two = await grant(owner.account, "Second client");
    expect((await post(`/account/grants/${one.id}/revoke`, owner.cookie, { csrf: owner.csrf })).status).toBe(303);
    expect(await authorize(one)).toBeNull();
    expect(await authorize(two)).not.toBeNull();
    expect(await (await get("/account", owner.cookie)).text()).not.toContain("First client");

    expect((await post("/account/disconnect", owner.cookie, { csrf: owner.csrf })).status).toBe(303);
    expect(await authorize(two)).toBeNull();
    expect(await store.getAccount(owner.account.id)).toMatchObject({ credentialVersion: 1, authorizationEpoch: 1 });
    const page = await get("/account", owner.cookie);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Capy key connected");
    expect(html).not.toContain("Second client");
    expect(fetch).not.toHaveBeenCalled();
  });
});
