import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import worker from "../../src/worker.js";
import { hostedEnv } from "./fixtures.js";
import { clientFlow, completionTarget, redirect, resource, serveHosted } from "./oauth-flow.js";
import { signedIdToken, signingJwk } from "./fixtures/oidc-signing.js";
import { signingKey } from "./fake-issuer.js";
import { resetHostedDb } from "./setup.js";
import { createStore } from "../../src/hosted/store.js";

let keys: CryptoKeyPair;
beforeAll(async () => { keys = await signingKey(); });
beforeEach(resetHostedDb);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(["withdrawn", "unconfigured"])("lets only the current browser sign out from a fresh %s account page", async kind => {
  const flow = await clientFlow(keys);
  await flow.signIn();
  const original = { ...flow.env };
  flow.env.OIDC_ALLOWED_SUBJECTS = '["no-member"]';
  if (kind === "unconfigured") Object.assign(flow.env, {
    OIDC_ALLOWED_SUBJECTS: "", OIDC_ADMISSION_CLAIM: "", OIDC_ALLOWED_CLAIM_VALUES: "",
    CREDENTIAL_ENCRYPTION_KEY: "", OIDC_CLIENT_SECRET: "", OIDC_ISSUER: "",
  });
  const denied = await flow.visit("/account");
  expect(denied.status).toBe(403);
  const html = await denied.text();
  expect(html.match(/<form[^>]*action="([^"]+)"/g)).toEqual(['<form method="post" action="/auth/logout"']);
  expect(denied.headers.get("Referrer-Policy")).toBe("strict-origin");
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const originalCookies = new Map(flow.cookies);
  expect((await flow.visit("/account/key", flow.form({ key: "fixture", generation: "0" }))).status).toBeGreaterThanOrEqual(400);
  expect((await flow.visit("/auth/logout", new URLSearchParams({ csrf: "wrong" }))).status).toBe(403);
  expect((await flow.visit("/auth/logout", new URLSearchParams({ csrf }))).status).toBe(303);
  Object.assign(flow.env, original);
  for (const [key, value] of originalCookies) flow.cookies.set(key, value);
  expect((await flow.visit("/account")).status).toBe(401);
});

it("fails closed on a metadata provider exception and emits only a fixed warning", async () => {
  const flow = await clientFlow(keys);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const clientId = "https://unavailable.example.invalid/metadata/sentinel-path";
  vi.stubGlobal("fetch", async () => { throw new Error("sentinel-provider-error"); });
  const response = await flow.authorize({ client_id: clientId });
  expect(response.status).toBe(503);
  expect((await response.text()).includes("sentinel")).toBe(false);
  expect(response.headers.has("Location")).toBe(false);
  expect(await flow.env.DB.prepare("SELECT count(*) AS total FROM app_grants").first("total")).toBe(0);
  expect(warning.mock.calls.length).toBe(1);
  expect(JSON.stringify(warning.mock.calls).includes("sentinel")).toBe(false);
  expect(warning).toHaveBeenCalledWith("CIMD fetch failed");
});

it.each(["/token", "/register"])("makes only public %s failures readable without browser credentials", async path => {
  const origin = "https://client.example.invalid";
  const check = async (env: Env, fields: URLSearchParams, status: number, error: string) => {
    const response = await serveHosted(new Request(env.PUBLIC_ORIGIN + path, { method: "POST", headers: { Origin: origin }, body: fields }), env);
    expect(response.status).toBe(status);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Vary")).toContain("Origin");
    expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(false);
    expect(await response.json()).toEqual({ error });
  };
  const env = hostedEnv();
  await check(env, new URLSearchParams({ field: "x".repeat(33_000) }), 413, "invalid_request");
  await check(hostedEnv({ AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) } }), new URLSearchParams(), 429, "temporarily_unavailable");
  await check(hostedEnv({ OIDC_CLIENT_SECRET: "" }), new URLSearchParams(), 503, "server_error");
  if (path === "/token") await check(env, new URLSearchParams({ grant_type: "refresh_token" }), 400, "invalid_target");
  for (const local of ["/account", "/authorize", "/consent", "/mcp"]) {
    const response = await serveHosted(new Request(env.PUBLIC_ORIGIN + local, { headers: { Origin: origin } }), env);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  }
});

it("fails closed before registration when the limiter throws without exposing its error", async () => {
  const env = hostedEnv({ AUTH_RATE_LIMITER: { limit: async () => { throw new Error("sentinel-limiter-error"); } } });
  const registrations = () => env.OAUTH_KV.list({ prefix: "client:" }).then(page => page.keys.length);
  const before = await registrations();
  const response = await serveHosted(new Request(env.PUBLIC_ORIGIN + "/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Fixture client", redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
  }), env);
  expect(response.status).toBe(503);
  expect((await response.text()).includes("sentinel")).toBe(false);
  expect(await registrations()).toBe(before);
});

it.each(["allow", "deny"])("ends the %s POST on a private same-origin document before navigating back to the client", async decision => {
  const flow = await clientFlow(keys);
  const consent = await flow.onboard("fixture-key");
  expect(consent.headers.get("Content-Security-Policy")).toMatch(/form-action 'self'(?:;|,|$)/);
  const page = await flow.decide(consent, decision);
  expect(page.status).toBe(200);
  expect(page.headers.has("Location")).toBe(false);
  expect(page.headers.get("Content-Type")).toContain("text/html");
  expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(page.headers.get("Cache-Control")).toBe("no-store");
  expect(page.headers.get("Content-Security-Policy")).toMatch(/form-action 'self'(?:;|$)/);
  expect(page.headers.getSetCookie().some(v => v.startsWith("__Host-oauth-consent") && v.includes("Max-Age=0"))).toBe(true);
  const next = completionTarget(page);
  expect(next.origin + next.pathname).toBe(redirect);
  expect(next.searchParams.get("state")).toBe("client-state");
  expect(next.searchParams.has("code")).toBe(decision === "allow");
  const html = await page.text();
  const code = next.searchParams.get("code");
  if (code) expect(html.includes(code)).toBe(false);
  expect(html).not.toMatch(/client-state|code=|state=|client\.example\.invalid|<form|<script/i);
});

it("rejects a repeated code exchange even if KV returns the pre-exchange grant", async () => {
  const flow = await clientFlow(keys);
  const approved = await flow.decide(await flow.onboard("fixture-key"));
  const code = completionTarget(approved).searchParams.get("code")!;
  const owner = await flow.env.DB.prepare("SELECT id FROM accounts").first<string>("id");
  const [entry] = (await flow.env.OAUTH_KV.list({ prefix: "grant:" + owner + ":" })).keys;
  const before = await flow.env.OAUTH_KV.get(entry.name);
  expect((await flow.exchange(code)).status).toBe(200);
  await flow.env.OAUTH_KV.put(entry.name, before!);
  expect((await flow.exchange(code)).status).toBe(400);
});

it("requires fresh consent if issuance fails after the D1 code claim", async () => {
  const flow = await clientFlow(keys);
  const approved = await flow.decide(await flow.onboard("fixture-key"));
  const code = completionTarget(approved).searchParams.get("code")!;
  await flow.env.DB.exec("ALTER TABLE credentials RENAME TO unavailable_vault");
  try {
    expect((await flow.exchange(code)).status).toBe(503);
  } finally {
    await flow.env.DB.exec("ALTER TABLE unavailable_vault RENAME TO credentials");
  }
  const retried = await flow.exchange(code);
  expect(retried.status).toBe(400);
  expect(await retried.json()).toMatchObject({ error: "invalid_grant" });
});

it.each([200, 302, 206])("authenticates a signed client only with direct HTTP 200 keys (status %i)", async status => {
  const flow = await clientFlow(keys);
  await flow.onboard("fixture-key");
  const client = "https://signed.example.invalid/metadata";
  const jwks = "https://signed.example.invalid/keys";
  const pair = await signingKey();
  const publicKey = await signingJwk(pair.publicKey);
  let mode: RequestRedirect | undefined;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    if (input === client) return Response.json({ client_id: client, client_name: "Signed fixture",
      redirect_uris: [redirect], token_endpoint_auth_method: "private_key_jwt", jwks_uri: jwks });
    if (input !== jwks) throw new Error("Unexpected fixture request");
    mode = init.redirect;
    return status === 302 ? Response.redirect("https://other.example.invalid/keys") : Response.json({ keys: [publicKey] }, { status });
  });
  const decision = await flow.decide(await flow.authorize({ client_id: client }));
  const code = completionTarget(decision).searchParams.get("code")!;
  const client_assertion = await signedIdToken(pair.privateKey, {
    iss: client, sub: client, aud: flow.env.PUBLIC_ORIGIN + "/token", exp: Math.floor(Date.now()/1000) + 60, jti: crypto.randomUUID(),
  });
  const exchanged = await flow.exchange(code, { client_id: client, client_assertion,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" });
  const body = await exchanged.json<{ access_token?: string; error?: string }>();
  if (status === 200) {
    expect(exchanged.status).toBe(200);
    expect(typeof body.access_token).toBe("string");
  } else {
    expect(body.error).toBe("invalid_client");
    expect(body.access_token).toBeUndefined();
  }
  expect(mode).toBe("manual");
});

it("requires exactly HTTP 200 even for a parseable client metadata document", async () => {
  const flow = await clientFlow(keys);
  await flow.onboard("fixture-key");
  const clientId = "https://partial.example.invalid/metadata";
  vi.stubGlobal("fetch", async () => Response.json({
    client_id: clientId, client_name: "Partial", redirect_uris: [redirect], token_endpoint_auth_method: "none",
  }, { status: 206 }));
  expect((await flow.authorize({ client_id: clientId })).status).not.toBe(200);
});

it("does not apply a stale connect-only onboarding form to a now-connected account", async () => {
  const flow = await clientFlow(keys);
  const { resume } = await flow.signIn();
  const page = await flow.visit(resume);
  const action = (await page.text()).match(/action="(\/account\/key[^"]*)"/)![1];
  expect((await flow.visit("/account/key", flow.form({ key: "current-key", generation: "0" }))).status).toBe(303);
  const allowed = await flow.decide(await flow.authorize());
  expect((await flow.exchange(completionTarget(allowed).searchParams.get("code")!)).status).toBe(200);
  const owner = await flow.env.DB.prepare("SELECT id FROM accounts").first<string>("id");
  const state = async () => [await flow.env.DB.prepare("SELECT * FROM credentials").first(),
    await createStore(flow.env.DB).getAccount(owner!), await createStore(flow.env.DB).listGrants(owner!)];
  const before = await state();
  expect((await flow.visit(action, flow.form({ key: "stale-key" }))).status).toBe(409);
  expect(await state()).toEqual(before);
});

it.each(["expired", "foreign", "consumed", "generation", "expires-during-validation"])("refuses %s onboarding without changing the vault", async kind => {
  const flow = await clientFlow(keys);
  const { resume } = await flow.signIn();
  const page = await flow.visit(resume);
  expect(page.headers.get("Content-Security-Policy")).toMatch(/form-action 'self'(?:;|$)/);
  const action = (await page.text()).match(/action="(\/account\/key[^"]*)"/)![1];
  const expire = () => flow.env.DB.prepare("UPDATE pending_authorizations SET expires_at=0").run();
  if (kind === "expired") await expire();
  if (kind === "consumed" || kind === "generation") {
    expect((await flow.visit(action, flow.form({ key: "fixture-current" }))).status).toBe(303);
    if (kind === "consumed") expect((await flow.visit(resume)).status).toBe(200);
    expect((await flow.visit("/account/key/delete", flow.form({ generation: "1" }))).status).toBe(303);
  }
  const poster = kind === "foreign" ? await clientFlow(keys, "other-member") : flow;
  if (poster !== flow) await poster.signIn();
  const delegated = vi.fn(async () => {
    if (kind === "expires-during-validation") await expire();
    return Response.json({ projects: [] });
  });
  const generations = () => flow.env.DB.prepare("SELECT id, credential_version FROM accounts ORDER BY id").all();
  const before = await generations();
  vi.stubGlobal("fetch", delegated);
  const denied = await poster.visit(action, poster.form({ key: "unwanted-key" }));
  expect(denied.status).toBe(409);
  expect(delegated).toHaveBeenCalledTimes(kind === "expires-during-validation" ? 1 : 0);
  expect((await generations()).results).toEqual(before.results);
  expect(await flow.env.DB.prepare("SELECT count(*) FROM credentials").first("count(*)")).toBe(0);
});

it("does not issue a refresh token without consent for offline access", async () => {
  const flow = await clientFlow(keys);
  await flow.onboard("fixture-key");
  const authorized = await flow.decide(await flow.authorize({ scope: "" }));
  const response = await flow.exchange(completionTarget(authorized).searchParams.get("code")!);
  const value = await response.json<Record<string, unknown>>();
  expect(value.scope).toBe("capy:read");
  expect(value).not.toHaveProperty("refresh_token");
});

it("shows the vetted client metadata document's verified domain and untrusted name as text", async () => {
  const flow = await clientFlow(keys);
  await flow.onboard("fixture-key");
  const clientId = "https://desktop.example.invalid/oauth/client.json";
  const fetchDocument = vi.fn(async () => Response.json({
    client_id: clientId, client_name: "<img src=x>", redirect_uris: [redirect], token_endpoint_auth_method: "none",
  }));
  vi.stubGlobal("fetch", fetchDocument);
  const page = await flow.authorize({ client_id: clientId });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("verified domain: desktop.example.invalid");
  expect(html).toContain("&lt;img src=x&gt;");
  expect(fetchDocument).toHaveBeenCalledWith(clientId, expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it("denies through the provider's stored redirect and rejects consumed or unbound handles", async () => {
  const flow = await clientFlow(keys);
  const page = await flow.onboard("fixture-key");
  const cookie = [...flow.cookies].find(([k]) => k.startsWith("__Host-oauth-consent"))!;
  flow.cookies.delete(cookie[0]);
  expect((await flow.decide(page.clone())).status).toBe(400);
  flow.cookies.set(...cookie);
  const denied = await flow.decide(page.clone(), "deny");
  expect(denied.status).toBe(200);
  expect(denied.headers.getSetCookie().some(v => v.includes("Max-Age=0"))).toBe(true);
  const destination = completionTarget(denied);
  expect(destination.origin + destination.pathname).toBe(redirect);
  expect(Object.fromEntries(destination.searchParams)).toMatchObject({ error: "access_denied", state: "client-state" });
  flow.cookies.set(...cookie);
  expect((await flow.decide(page)).status).toBe(400);
});

it("binds the callback and resume to the original browser session", async () => {
  const a = await clientFlow(keys);
  const { callback, resume } = await a.signIn();
  expect((await a.visit(callback)).status).toBe(400);
  const b = await clientFlow(keys, "member-2");
  await b.signIn();
  expect((await b.visit(resume)).status).toBe(400);
  expect((await a.visit(resume)).status).toBe(200);
});

it.each(["/account/key", "/account/disconnect"])("will not grant from a consent page opened before %s", async path => {
  const flow = await clientFlow(keys);
  const page = await flow.onboard("fixture-key");
  expect((await flow.visit(path, flow.form({ key: "fixture-replacement", generation: "1" }))).status).toBe(303);
  const stale = await flow.decide(page);
  expect(stale.status).toBe(409);
  expect(stale.headers.has("Location")).toBe(false);
  expect(stale.headers.has("Refresh")).toBe(false);
  expect(await flow.env.DB.prepare("SELECT count(*) FROM app_grants").first("count(*)")).toBe(0);
});

it("uses the consent form at most once even when both approvals arrive together", async () => {
  const flow = await clientFlow(keys);
  const page = await flow.onboard("fixture-key");
  const [a, b] = await Promise.all([flow.decide(page.clone()), flow.decide(page)]);
  expect([a, b].filter(r => r.status === 200)).toHaveLength(1);
  expect(await flow.env.DB.prepare("SELECT count(*) FROM app_grants").first("count(*)")).toBe(1);
});

it("preserves provider cookie clearing when the authority store fails after approval", async () => {
  const flow = await clientFlow(keys);
  const page = await flow.onboard("fixture-key");
  await flow.env.DB.exec("ALTER TABLE consent_snapshots RENAME TO unavailable_snapshots");
  try {
    const failed = await flow.decide(page);
    expect(failed.status).toBe(503);
    expect(failed.headers.has("Location")).toBe(false);
    expect(failed.headers.has("Refresh")).toBe(false);
    expect(failed.headers.getSetCookie().some(v => v.startsWith("__Host-oauth-consent") && v.includes("Max-Age=0"))).toBe(true);
  } finally {
    await flow.env.DB.exec("ALTER TABLE unavailable_snapshots RENAME TO consent_snapshots");
  }
});

it("blocks an unexchanged code after revoking its app grant", async () => {
  const flow = await clientFlow(keys);
  const approved = await flow.decide(await flow.onboard("fixture-key"));
  const id = await flow.env.DB.prepare("SELECT id FROM app_grants").first<string>("id");
  expect((await flow.visit("/account/grants/" + id + "/revoke", flow.form({}))).status).toBe(303);
  const code = completionTarget(approved).searchParams.get("code")!;
  const response = await flow.exchange(code);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "invalid_grant" });
});

it("never stores or returns the upstream key in protocol material", async () => {
  const key = "fixture-capy-sensitive-value";
  const flow = await clientFlow(keys);
  const response = await flow.connect(key);
  expect(JSON.stringify(response)).not.toContain(key);
  const { keys: entries } = await flow.env.OAUTH_KV.list();
  for (const entry of entries) {
    expect(entry.name).not.toContain(key);
    expect(await flow.env.OAUTH_KV.get(entry.name)).not.toContain(key);
  }
  const grant = await flow.env.DB.prepare("SELECT * FROM app_grants").first();
  expect(JSON.stringify(grant)).not.toContain(key);
});

it("keeps browser mutations out of public discovery preflight", async () => {
  const env = hostedEnv();
  const options = (path: string) => serveHosted(new Request(env.PUBLIC_ORIGIN + path,
    { method: "OPTIONS", headers: { Origin: "https://desktop.example.invalid" } }), env);
  const discovery = await options("/.well-known/oauth-authorization-server");
  expect(discovery.status).toBe(204);
  expect(discovery.headers.has("Access-Control-Allow-Credentials")).toBe(false);
  for (const path of ["/consent", "/account/key", "/auth/logout"]) {
    const response = await options(path);
    expect(response.status).toBe(405);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  }
});

it("rejects modified consent fields and invalid scopes, PKCE or resource indicators", async () => {
  const flow = await clientFlow(keys);
  const invalid: [Record<string, string>, string][] = [
    [{ scope: "capy:admin" }, "invalid_scope"], [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge: "" }, "invalid_request"], [{ code_challenge: "short" }, "invalid_request"],
    [{ resource: resource + "/" }, "invalid_target"], [{ resource: "" }, "invalid_target"],
    [{ response_type: "unsupported" }, "unsupported_response_type"],
  ];
  for (const [override, code] of invalid) {
    const response = await flow.authorize(override);
    const target = completionTarget(response);
    expect(target.origin + target.pathname).toBe(redirect);
    expect(Object.fromEntries(target.searchParams)).toEqual({ error: code, state: "client-state", iss: flow.env.PUBLIC_ORIGIN });
    expect(response.headers.has("Location")).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await response.text()).not.toMatch(/client-state|example\.invalid/);
  }
  const unknown: Record<string, string>[] = [{ redirect_uri: redirect + "/other" }, { client_id: "unknown-client" }];
  for (const override of unknown) {
    const local = await flow.authorize(override);
    expect(local.status).toBe(400);
    expect(local.headers.has("Location") || local.headers.has("Refresh")).toBe(false);
  }
  const page = await flow.onboard("fixture-key");
  const handle = (await page.clone().text()).match(/name="handle" value="([^"]+)"/)![1];
  expect((await flow.visit("/consent", flow.form({ handle, decision: "allow", redirect_uri: "https://else.example.invalid/" }))).status).toBe(400);
  const authorized = await flow.decide(page, "allow", true);
  const code = completionTarget(authorized).searchParams.get("code")!;
  expect((await flow.exchange(code, { code_verifier: "wrong".repeat(12) })).status).toBe(400);
  expect((await flow.exchange(code, { resource: resource + "/other" })).status).toBe(400);
});

it.each(["/token", "/register"])("bounds chunked %s protocol submissions before handing them to the provider", async path => {
  const env = hostedEnv();
  const body = new ReadableStream<Uint8Array>({
    pull(c) { c.enqueue(new Uint8Array(32_769)); c.close(); },
  });
  const response = await serveHosted(new Request(env.PUBLIC_ORIGIN + path, { method: "POST", body,
    headers: { "Content-Type": path === "/token" ? "application/x-www-form-urlencoded" : "application/json" } }), env);
  expect(response.status).toBe(413);
});

it.each(["/token", "/register", "/authorize"])("rate limits %s before parsing or calling a client or issuer", async path => {
  const env = hostedEnv({ AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) } });
  const response = await serveHosted(new Request(env.PUBLIC_ORIGIN + path, { method: path === "/authorize" ? "GET" : "POST" }), env);
  expect(response.status).toBe(429);
});

it("rejects a code exchange missing the explicit MCP resource", async () => {
  const flow = await clientFlow(keys);
  const allowed = await flow.decide(await flow.onboard("fixture-key"));
  const code = completionTarget(allowed).searchParams.get("code")!;
  const response = await flow.token({ grant_type: "authorization_code", code, redirect_uri: redirect,
    code_verifier: "fixture-verifier-".repeat(4) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "invalid_target" });
});

it("requires the canonical resource on refresh as well as the code exchange", async () => {
  const flow = await clientFlow(keys);
  const { refresh_token } = await flow.connect("fixture-key");
  const response = await flow.token({ grant_type: "refresh_token", refresh_token });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "invalid_target" });
});

it("links issued provider grants and cleans their KV records after account revocation", async () => {
  const flow = await clientFlow(keys);
  await flow.connect("fixture-key");
  const accountId = await flow.env.DB.prepare("SELECT id FROM accounts").first<string>("id");
  const [grant] = await createStore(flow.env.DB).listGrants(accountId!);
  const kv = "grant:" + accountId + ":" + grant.providerGrantId;
  expect(await flow.env.OAUTH_KV.get(kv)).not.toBeNull();
  expect((await flow.visit("/account/grants/" + grant.id + "/revoke", flow.form({}))).status).toBe(303);
  expect(await flow.env.OAUTH_KV.get(kv)).toBeNull();
});

it("preserves the validated request through signed login and key onboarding to explicit consent", async () => {
  const flow = await clientFlow(keys);
  const page = await flow.onboard("fixture-upstream-key");
  const html = await page.clone().text();
  expect(html).toContain("&lt;b&gt;Unverified&lt;/b&gt;");
  expect(html).toContain(new URL(redirect).host);
  expect(html).not.toContain("fixture-upstream-key");
  expect(page.headers.getSetCookie().some(v => v.startsWith("__Host-oauth-consent"))).toBe(true);
  const authorized = await flow.decide(page);
  expect(authorized.status).toBe(200);
  const callback = completionTarget(authorized);
  expect(callback.searchParams.get("state")).toBe("client-state");
  const result = await flow.exchange(callback.searchParams.get("code")!);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ scope: "capy:read offline_access", refresh_token: expect.any(String) });
});

it("discovers one canonical protected resource and issuer from the bearer challenge", async () => {
  const env = hostedEnv();
  const get = (path: string) => worker.fetch(new Request(new URL(path, env.PUBLIC_ORIGIN)), env, createExecutionContext());
  const resource = env.PUBLIC_ORIGIN + "/mcp";
  const response = await get(resource);
  expect(response.status).toBe(401);
  const metadata = response.headers.get("WWW-Authenticate")?.match(/resource_metadata="([^"]+)"/)?.[1];
  expect(metadata).toBe(env.PUBLIC_ORIGIN + "/.well-known/oauth-protected-resource/mcp");
  expect(await (await get(metadata!)).json()).toMatchObject({ resource, authorization_servers: [env.PUBLIC_ORIGIN], scopes_supported: ["capy:read"] });
  expect(await (await get("/.well-known/oauth-authorization-server")).json()).toMatchObject({
    issuer: env.PUBLIC_ORIGIN, token_endpoint: env.PUBLIC_ORIGIN + "/token", registration_endpoint: env.PUBLIC_ORIGIN + "/register",
    scopes_supported: ["capy:read", "capy:write", "offline_access"], client_id_metadata_document_supported: true,
  });
});
