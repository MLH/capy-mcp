import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { beginLogin, csrfToken, finishLogin, logout, requireMutation, requireSession } from "../../src/hosted/browser.js";
import { hashOpaqueId } from "../../src/hosted/crypto.js";
import { createStore } from "../../src/hosted/store.js";
import { browserOrigin, entraIssuer, fakeIssuer, signingKey } from "./fake-issuer.js";
import { hostedEnv } from "./fixtures.js";
import { resetHostedDb } from "./setup.js";

let keys: CryptoKeyPair;
beforeAll(async () => { keys = await signingKey(); });
beforeEach(resetHostedDb);
afterEach(() => vi.unstubAllGlobals());

const account = { kind: "account" } as const;
const loginCookie = "__Host-capy-login";
const sessionCookie = "__Host-capy-session";
const csrfCookie = "__Host-capy-csrf";
const sessionId = "A".repeat(43);
const csrf = "B".repeat(42) + "A";

function cookie(response: Response, name: string): string {
  return response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`))?.split(";", 1)[0] ?? "";
}

function callbackRequest(url: URL, ...cookies: string[]): Request {
  return new Request(url, { headers: { cookie: cookies.join("; ") } });
}

function startRequest(path = "/login", headers?: HeadersInit): Request {
  return new Request(new URL(path, browserOrigin), { headers });
}

function mutation(body = new URLSearchParams({ csrf }), origin: string | null = browserOrigin, method = "POST") {
  return new Request(`${browserOrigin}/account`, {
    method,
    headers: { cookie: `${sessionCookie}=${sessionId}; ${csrfCookie}=${csrf}`, ...(origin ? { origin } : {}) },
    ...(method === "POST" ? { body } : {}),
  });
}

async function signedIn(options: Parameters<typeof fakeIssuer>[1] = {}, oldCookie = "") {
  const provider = await fakeIssuer(keys, options);
  const start = await beginLogin(startRequest("/login", { cookie: oldCookie }), provider.env, account);
  expect(start.status).toBe(303);
  const callback = callbackRequest(provider.callback(start), cookie(start, loginCookie), oldCookie);
  return { provider, start, callback, finish: await finishLogin(callback, provider.env) };
}

async function seedSession(expiresAt = Date.now() + 3_600_000) {
  const env = hostedEnv({ AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) } });
  const store = createStore(env.DB);
  const user = await store.getOrCreateAccount({
    issuer: env.OIDC_ISSUER, subject: "fixture-member", admissionClaims: { hd: "team.example.invalid" },
  });
  await store.createSession(sessionId, { accountId: user.id, csrfHash: await hashOpaqueId(csrf), expiresAt });
  return { env, store, user };
}

function expectProtected(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
}

function expectCookie(response: Response, name: string, maxAge: number) {
  const line = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  const attributes = line?.split("; ").slice(1);
  expect(attributes).toEqual(expect.arrayContaining(["Path=/", "Secure", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`]));
  expect(attributes?.some((attribute) => /^domain=/i.test(attribute))).toBe(false);
}

describe("browser-bound OIDC sign-in", () => {
  it.each([
    ["Google's signed hosted-domain claim", undefined, "hd", "team.example.invalid"],
    ["Entra's signed tenant claim", entraIssuer, "tid", "00000000-0000-4000-8000-000000000002"],
  ])("signs in using %s with code, S256, state and nonce", async (_name, issuer, claimName, claimValue) => {
    const { provider, start, finish } = await signedIn({ issuer, claimName, claimValue });
    const authorization = new URL(start.headers.get("Location") ?? "");
    expect(authorization.origin + authorization.pathname).toBe(provider.authorization);
    expect(authorization.searchParams.get("response_type")).toBe("code");
    expect(authorization.searchParams.get("scope")).toBe("openid");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("redirect_uri")).toBe(`${browserOrigin}/auth/callback`);
    expect(authorization.searchParams.has("client_secret")).toBe(false);
    const suppliedSecrets = ["nonce", "state", "code_challenge"].map((name) => authorization.searchParams.get(name));
    expect(suppliedSecrets.every((value) => value !== null && /^[A-Za-z0-9_-]{43}$/.test(value))).toBe(true);
    expect(new Set(suppliedSecrets).size).toBe(3);
    expect(finish.status).toBe(303);
    expect(finish.headers.get("Location")).toBe("/account");
    expect(provider.requests).toContain(provider.jwks);
    expectProtected(start);
    expectProtected(finish);
    expectCookie(start, loginCookie, 600);
    expectCookie(finish, loginCookie, 0);
    expectCookie(finish, sessionCookie, 3_600);
    expectCookie(finish, csrfCookie, 3_600);
    expect(finish.headers.getSetCookie().every((line) => !line.includes("fixture-access-token") && !line.includes("fixture-refresh-token"))).toBe(true);
    const page = startRequest("/account", { cookie: [cookie(finish, sessionCookie), cookie(finish, csrfCookie)].join("; ") });
    const context = await requireSession(page, provider.env);
    if (context instanceof Response) throw new Error(`Session read returned ${context.status}`);
    expect(context.account.identity).toEqual({
      issuer: provider.env.OIDC_ISSUER, subject: "member-1", admissionClaims: { [claimName]: claimValue },
    });
    expect(context.session.expiresAt - Date.now()).toBeGreaterThan(3_590_000);
    expect(context.session.expiresAt - Date.now()).toBeLessThanOrEqual(3_600_000);
    const formValue = await csrfToken(page, context.session);
    expect(typeof formValue).toBe("string");
    expect(formValue !== null && await hashOpaqueId(formValue) === context.session.csrfHash).toBe(true);
  });

  it.each([
    ["invalid signature with valid claims and matching key ID", {}, true],
    ["issuer mismatch", { iss: "https://login.example.invalid" }, false],
    ["audience mismatch", { aud: "different-client" }, false],
    ["authorized party mismatch even with one audience", { azp: "different-client" }, false],
    ["additional untrusted audience", { aud: ["test-client", "different-client"], azp: "test-client" }, false],
    ["expired ID token", { exp: 1 }, false],
    ["nonce mismatch", { nonce: "different-nonce" }, false],
  ])("rejects %s without a session or upstream details", async (_name, claims, corruptSignature) => {
    const { finish } = await signedIn({ claims, corruptSignature });
    expect(finish.status).toBe(400);
    expect(finish.headers.has("Location")).toBe(false);
    expect(cookie(finish, sessionCookie)).toBe("");
    expect(await finish.text()).toBe("Sign-in failed.");
    expectProtected(finish);
  });

  it("rejects absent/wrong browser bindings, changed or duplicate state, and replay without exchanging them", async () => {
    const provider = await fakeIssuer(keys);
    const start = await beginLogin(startRequest(), provider.env, account);
    expect(start.status).toBe(303);
    const url = provider.callback(start);
    const browser = cookie(start, loginCookie);
    const changed = new URL(url);
    changed.searchParams.set("state", "B".repeat(42) + "A");
    const duplicate = new URL(url);
    duplicate.searchParams.append("state", duplicate.searchParams.get("state") ?? "");
    for (const request of [callbackRequest(url), callbackRequest(url, `${loginCookie}=${sessionId}`),
      callbackRequest(changed, browser), callbackRequest(duplicate, browser)]) {
      expect((await finishLogin(request, provider.env)).status).toBe(400);
    }
    expect(provider.requests).not.toContain(provider.token);
    const [first, raced] = await Promise.all([
      finishLogin(callbackRequest(url, browser), provider.env),
      finishLogin(callbackRequest(url, browser), provider.env),
    ]);
    expect([first.status, raced.status].sort()).toEqual([303, 400]);
    expect((await finishLogin(callbackRequest(url, browser), provider.env)).status).toBe(400);
    expect(provider.requests.filter((endpoint) => endpoint === provider.token)).toHaveLength(1);
  });

  it("expires the login in D1 and never tries to exchange its code", async () => {
    const provider = await fakeIssuer(keys);
    const start = await beginLogin(startRequest(), provider.env, account);
    const url = provider.callback(start);
    const result = await provider.env.DB.prepare("SELECT expires_at AS expiresAt FROM login_transactions").first<{ expiresAt: number }>();
    expect((result?.expiresAt ?? 0) - Date.now()).toBeGreaterThan(590_000);
    expect((result?.expiresAt ?? 0) - Date.now()).toBeLessThanOrEqual(600_000);
    await provider.env.DB.prepare("UPDATE login_transactions SET expires_at = 1").run();
    expect((await finishLogin(callbackRequest(url, cookie(start, loginCookie)), provider.env)).status).toBe(400);
    expect(provider.requests).not.toContain(provider.token);
  });

  it("does not start login for a foreign Origin or send a code from the wrong callback host or path", async () => {
    const provider = await fakeIssuer(keys);
    const foreign = await beginLogin(startRequest("/login", { Origin: "https://untrusted.invalid" }), provider.env, account);
    expect(foreign.status).toBe(400);
    expect(foreign.headers.has("Set-Cookie")).toBe(false);
    expect(provider.requests).toHaveLength(0);
    const start = await beginLogin(startRequest(), provider.env, account);
    const url = provider.callback(start);
    const bound = cookie(start, loginCookie);
    const wrongHost = new URL(url);
    wrongHost.host = "untrusted.invalid";
    const wrongPath = new URL(url);
    wrongPath.pathname = "/elsewhere";
    expect((await finishLogin(callbackRequest(wrongHost, bound), provider.env)).status).toBe(400);
    expect((await finishLogin(callbackRequest(wrongPath, bound), provider.env)).status).toBe(400);
    expect(provider.requests).not.toContain(provider.token);
    expect((await finishLogin(callbackRequest(url, bound), provider.env)).status).toBe(303);
  });

  it("ignores request return URLs and resumes only the validated persisted transaction", async () => {
    const provider = await fakeIssuer(keys);
    const start = await beginLogin(startRequest("/login?returnTo=https://untrusted.invalid"), provider.env, {
      kind: "authorize", transactionId: "tenant_transaction-1",
    });
    const url = provider.callback(start);
    url.searchParams.set("returnTo", "//untrusted.invalid");
    const finish = await finishLogin(callbackRequest(url, cookie(start, loginCookie)), provider.env);
    expect(finish.status).toBe(303);
    expect(finish.headers.get("Location")).toBe("/oauth/resume?transaction=tenant_transaction-1");
    const invalid = await beginLogin(startRequest(), provider.env, { kind: "authorize", transactionId: "//untrusted.invalid" });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.has("Location")).toBe(false);
  });

  it.each([
    ['{"kind":"account","returnTo":"//untrusted.invalid"}'],
    ['{"kind":"authorize","kind":"account"}'],
  ])("fails closed when the stored continuation is not canonical: %s", async (continuation) => {
    const provider = await fakeIssuer(keys);
    const start = await beginLogin(startRequest(), provider.env, account);
    await provider.env.DB.prepare("UPDATE login_transactions SET continuation = ?")
      .bind(continuation).run();
    const finish = await finishLogin(callbackRequest(provider.callback(start), cookie(start, loginCookie)), provider.env);
    expect(finish.status).toBe(400);
    expect(finish.headers.has("Location")).toBe(false);
    expect(provider.requests).not.toContain(provider.token);
  });

  it("rotates and deletes the old session, without merging equal emails across subjects", async () => {
    const first = await signedIn();
    expect(first.finish.status).toBe(303);
    const oldCookie = cookie(first.finish, sessionCookie);
    const oldRequest = startRequest("/account", { cookie: oldCookie });
    const original = await requireSession(oldRequest, first.provider.env);
    if (original instanceof Response) throw new Error(`Original session returned ${original.status}`);
    const next = await signedIn({ claims: { sub: "different-member" } }, oldCookie);
    expect(next.finish.status).toBe(303);
    const newCookie = cookie(next.finish, sessionCookie);
    expect(newCookie !== oldCookie).toBe(true);
    const updated = await requireSession(startRequest("/account", { cookie: newCookie }), next.provider.env);
    if (updated instanceof Response) throw new Error(`Rotated session returned ${updated.status}`);
    expect(updated.account.id !== original.account.id).toBe(true);
    expect(updated.account.identity.subject).toBe("different-member");
    const old = await requireSession(oldRequest, next.provider.env);
    expect(old instanceof Response && old.status).toBe(401);
  });

  it("rechecks changed admission on existing sessions and at callback", async () => {
    const flow = await signedIn();
    expect(flow.finish.status).toBe(303);
    const changed = { ...flow.provider.env, OIDC_ALLOWED_SUBJECTS: '["another-member"]' };
    const current = await requireSession(startRequest("/account", { cookie: cookie(flow.finish, sessionCookie) }), changed);
    expect(current instanceof Response && current.status).toBe(403);
    const start = await beginLogin(startRequest(), flow.provider.env, account);
    const finish = await finishLogin(callbackRequest(flow.provider.callback(start), cookie(start, loginCookie)), changed);
    expect(finish.status).toBe(403);
    expect(cookie(finish, sessionCookie)).toBe("");
  });
});

describe("browser session mutation boundary", () => {
  it("rejects expired sessions even if the browser retains their cookies", async () => {
    const { env } = await seedSession(Date.now() - 60_000);
    const result = await requireSession(mutation(), env);
    expect(result instanceof Response && result.status).toBe(401);
  });

  it("rejects get, missing/foreign Origin, and missing, duplicate or incorrect form CSRF", async () => {
    const { env, store } = await seedSession();
    for (const [request, status] of [
      [mutation(undefined, browserOrigin, "GET"), 405],
      [mutation(undefined, null), 403],
      [mutation(undefined, "https://other.example.invalid"), 403],
      [mutation(undefined, "null"), 403],
      [mutation(new URLSearchParams()), 403],
      [mutation(new URLSearchParams([["csrf", csrf], ["csrf", csrf]])), 403],
      [mutation(new URLSearchParams({ csrf: sessionId })), 403],
    ] as const) {
      const result = await logout(request, env);
      expect(result.status).toBe(status);
      expect(result.headers.has("Set-Cookie")).toBe(false);
    }
    expect(await store.getSession(sessionId)).not.toBeNull();
  });

  it("provides validated form values and logs out by deleting the real D1 session", async () => {
    const { env, store, user } = await seedSession();
    const context = await requireMutation(mutation(new URLSearchParams({ csrf, action: "fixture" })), env);
    if (context instanceof Response) throw new Error(`Mutation returned ${context.status}`);
    expect(context.account.id).toBe(user.id);
    expect(context.form.get("action")).toBe("fixture");
    const response = await logout(mutation(), env);
    expect(response.status).toBe(303);
    expectProtected(response);
    expectCookie(response, sessionCookie, 0);
    expectCookie(response, csrfCookie, 0);
    expect(await store.getSession(sessionId)).toBeNull();
  });

  it("rejects oversized URL-encoded bodies without mutating the session", async () => {
    const { env, store } = await seedSession();
    const response = await logout(mutation(new URLSearchParams({ csrf, extra: "a".repeat(65_536) })), env);
    expect(response.status).toBe(413);
    expect(await store.getSession(sessionId)).not.toBeNull();
  });

  it("enforces both the shared anonymous auth bucket and the authenticated account bucket", async () => {
    const { env, user, store } = await seedSession();
    const authLimit = vi.fn(async (_input: { key: string }) => ({ success: false }));
    const accountLimit = vi.fn(async (_input: { key: string }) => ({ success: false }));
    const limited = { ...env, AUTH_RATE_LIMITER: { limit: authLimit }, ACCOUNT_RATE_LIMITER: { limit: accountLimit } };
    const start = await beginLogin(startRequest("/login", { "x-forwarded-for": "203.0.113.5" }), limited, account);
    const finish = await finishLogin(startRequest("/auth/callback"), limited);
    expect([start.status, finish.status]).toEqual([429, 429]);
    expect(authLimit.mock.calls[0][0].key).toBe(authLimit.mock.calls[1][0].key);
    const result = await requireMutation(mutation(), limited);
    expect(result instanceof Response && result.status).toBe(429);
    expect(accountLimit).toHaveBeenCalledWith({ key: user.id });
    expect(await store.getSession(sessionId)).not.toBeNull();
  });

  it("uses only Cloudflare edge IPs and ignores spoofable or invalid IP headers", async () => {
    const env = hostedEnv();
    const limit = vi.fn(async (_input: { key: string }) => ({ success: false }));
    const limited = { ...env, AUTH_RATE_LIMITER: { limit } };
    for (const [cf, headers] of [
      [{ colo: "IAD" }, { "CF-Connecting-IP": "2001:db8::7" }],
      [undefined, { "CF-Connecting-IP": "2001:db8::8" }],
      [{ colo: "IAD" }, { "CF-Connecting-IP": "invalid-ip" }],
      [{ colo: "IAD" }, { "CF-Connecting-IP": "2001:db8::9", "CF-Worker": "example.invalid" }],
    ] as const) {
      const request = new Request(`${browserOrigin}/login`, { headers, cf });
      expect((await beginLogin(request, limited, account)).status).toBe(429);
    }
    expect(limit.mock.calls.map(([input]) => input.key)).toEqual(["ip:2001:db8::7", "anonymous", "anonymous", "anonymous"]);
  });
});
