import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { clientFlow, resource, serveHosted } from "./oauth-flow.js";
import { signingKey } from "./fake-issuer.js";
import { resetHostedDb } from "./setup.js";
import worker from "../../src/worker.js";
import { handleMcp } from "../../src/hosted/mcp.js";
import { createStore } from "../../src/hosted/store.js";

let keys: CryptoKeyPair;
beforeAll(async () => { keys = await signingKey(); });
beforeEach(resetHostedDb);
afterEach(() => vi.unstubAllGlobals());

it.each(["many pages", "slow sibling"])("tracks and bounds provider KV operations for a single large grant (%s)", async kind => {
  const flow = await clientFlow(keys);
  await flow.connect("fixture-key");
  const request = () => new Request(flow.env.PUBLIC_ORIGIN + "/account/disconnect", {
    method: "POST", body: flow.form({}), headers: { Origin: flow.env.PUBLIC_ORIGIN,
      Cookie: [...flow.cookies].map(([k,v]) => k + "=" + v).join("; ") },
  });
  let release!: () => void, operations = 0;
  const outstanding = new Promise<void>(done => { release = done; });
  const remaining = new Set(Array.from({ length: 64 }, (_, i) => "fixture-" + i));
  const env = { ...flow.env, OAUTH_KV: new Proxy(flow.env.OAUTH_KV, { get(target, key) {
    if (key === "list") return async ({ limit = 1000 }) => {
      operations++;
      const keys = [...remaining].slice(0, limit).map(name => ({ name }));
      return { keys, list_complete: keys.length === remaining.size, cursor: "more" };
    };
    if (key === "delete") return async (id: string) => {
      operations++;
      if (kind === "slow sibling" && id === "fixture-0") throw new Error("Fixture unavailable");
      if (kind === "slow sibling" && id === "fixture-1") await outstanding;
      remaining.delete(id);
    };
    return Reflect.get(target, key);
  } }) };
  const ctx = createExecutionContext();
  expect((await worker.fetch(request(), env, ctx)).status).toBe(303);
  const settled = waitOnExecutionContext(ctx);
  if (kind === "slow sibling") {
    try {
      expect(await Promise.race([settled.then(() => true), new Promise<boolean>(done => setTimeout(() => done(false), 100))])).toBe(false);
    } finally { release(); await settled; }
    return;
  }
  await settled;
  expect(operations).toBeGreaterThan(1);
  expect(operations).toBeLessThanOrEqual(48);
  expect(remaining.size).toBeGreaterThan(0);
  const retry = createExecutionContext();
  expect((await worker.fetch(request(), env, retry)).status).toBe(303);
  await waitOnExecutionContext(retry);
  expect(remaining.size).toBe(0);
});

it("acknowledges a committed disconnect before slow provider cleanup, even if cleanup later fails", async () => {
  const flow = await clientFlow(keys);
  const tokens = await flow.connect("fixture-key");
  let release!: () => void;
  const slow = new Promise<void>(done => { release = done; });
  const kv = flow.env.OAUTH_KV;
  const env = { ...flow.env, OAUTH_KV: new Proxy(kv, { get(target, key) {
    if (key === "list") return async () => { await slow; throw new Error("Fixture unavailable"); };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } }) };
  const ctx = createExecutionContext();
  const request = new Request(env.PUBLIC_ORIGIN + "/account/disconnect", {
    method: "POST", body: flow.form({}), headers: { Origin: env.PUBLIC_ORIGIN,
      Cookie: [...flow.cookies].map(([k,v]) => k + "=" + v).join("; ") },
  });
  const response = worker.fetch(request, env, ctx);
  try {
    const result = await Promise.race([response, new Promise<null>(done => setTimeout(() => done(null), 750))]);
    expect(result?.status).toBe(303);
    expect((await rpc(flow.env, tokens.access_token)).status).toBe(401);
  } finally {
    release();
    await response;
    await waitOnExecutionContext(ctx);
  }
});

it("reflects verified refresh-token revocation in D1 before acknowledgement, without widening access-token revocation", async () => {
  const flow = await clientFlow(keys);
  const { access_token, refresh_token } = await flow.connect("fixture-owner");
  const kv = flow.env.OAUTH_KV;
  const id = await flow.env.DB.prepare("SELECT id FROM accounts").first<string>("id");
  const conn = () => createStore(flow.env.DB).getAccountConnection(id!);
  const before = await conn();
  expect(before.clients).toHaveLength(1);
  const other = await clientFlow(keys, "other");
  expect((await other.token({ token: refresh_token })).status).toBe(200);
  expect(await conn()).toEqual(before);
  expect((await flow.token({ token: access_token, token_type_hint: "refresh_token" })).status).toBe(200);
  expect(await conn()).toEqual(before);
  const renewed = await flow.token({ grant_type: "refresh_token", refresh_token, resource });
  const next = await renewed.json<{ access_token: string; refresh_token: string }>();
  const entries = (await Promise.all(["grant:", "token:"].map(async prefix =>
    Promise.all((await kv.list({ prefix: prefix + id + ":" })).keys.map(async k => [k.name, (await kv.get(k.name))!] as const))))).flat();
  await flow.env.DB.exec("CREATE TRIGGER revocation_unavailable BEFORE UPDATE OF revoked_at ON app_grants BEGIN SELECT RAISE(ABORT, 'unavailable'); END;");
  try {
    expect((await flow.token({ token: next.refresh_token })).status).toBe(503);
    expect(await conn()).toEqual(before);
  } finally {
    await flow.env.DB.exec("DROP TRIGGER revocation_unavailable");
  }
  expect((await flow.token({ token: next.refresh_token })).status).toBe(200);
  expect((await conn()).clients).toHaveLength(0);
  for (const [k, value] of entries) await kv.put(k, value);
  expect((await rpc(flow.env, next.access_token)).status).toBe(401);
  expect((await flow.token({ grant_type: "refresh_token", refresh_token: next.refresh_token, resource })).status).toBe(400);
});

function rpc(env: Env, token: string, method = "tools/list", params?: object) {
  return serveHosted(new Request(resource, { method: "POST", headers: {
    Authorization: "Bearer " + token, Accept: "application/json, text/event-stream", "Content-Type": "application/json",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env);
}

it("executes only GET tools with the consenting user's decrypted key", async () => {
  const flow = await clientFlow(keys);
  const { access_token } = await flow.connect("fixture-personal-key");
  const upstream = vi.fn(async () => Response.json({ issues: [] }));
  vi.stubGlobal("fetch", upstream);
  const listed = await rpc(flow.env, access_token);
  expect(listed.status).toBe(200);
  const names = (await listed.json<{ result: { tools: { name: string }[] } }>()).result.tools.map(t => t.name);
  expect(names).toContain("capy_issues_list");
  expect(names).not.toContain("capy_issues_create");
  const denied = await rpc(flow.env, access_token, "tools/call", { name: "capy_issues_create", arguments: {} });
  expect(await denied.json()).toMatchObject({ error: { code: -32602, message: expect.stringContaining("Unknown or disabled") } });
  expect(upstream).not.toHaveBeenCalled();
  const read = await rpc(flow.env, access_token, "tools/call", { name: "capy_issues_list" });
  expect(await read.json()).toMatchObject({ result: { structuredContent: { issues: [] } } });
  expect(upstream).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer fixture-personal-key" }) }));
});

it("points to account reconnection on upstream key rejection without reflecting the key or response", async () => {
  const flow = await clientFlow(keys);
  const { access_token } = await flow.connect("fixture-personal-key");
  vi.stubGlobal("fetch", async () => Response.json({ message: "fixture-personal-key" }, { status: 401 }));
  const response = await rpc(flow.env, access_token, "tools/call", { name: "capy_issues_list" });
  const text = await response.text();
  expect(text).not.toContain("fixture-personal-key");
  expect(JSON.parse(text)).toMatchObject({ result: { isError: true, structuredContent: { error: {
    status: 401, reconnect: flow.env.PUBLIC_ORIGIN + "/account",
  } } } });
});

it("refreshes, downscopes and revokes through the real token endpoint", async () => {
  const flow = await clientFlow(keys);
  const tokens = await flow.connect("fixture-key", true);
  expect(tokens.scope).toBe("capy:read capy:write offline_access");
  vi.stubGlobal("fetch", async () => Response.json({ code: "OK" }));
  expect(await (await rpc(flow.env, tokens.access_token, "tools/call", { name: "capy_issues_create",
    arguments: { body: { projectId: "fixture", title: "fixture" } } })).json()).toMatchObject({ result: { structuredContent: { code: "OK" } } });
  const refresh = { grant_type: "refresh_token", refresh_token: tokens.refresh_token };
  expect((await flow.token({ ...refresh, resource: resource + "/wrong" })).status).toBe(400);
  const renewed = await flow.token({ ...refresh, resource, scope: "capy:read" });
  expect(renewed.status).toBe(200);
  const narrowed = await renewed.json<typeof tokens>();
  expect(narrowed.scope).toBe("capy:read");
  const denied = await rpc(flow.env, narrowed.access_token, "tools/call", { name: "capy_issues_create" });
  expect(await denied.json()).toMatchObject({ error: { code: -32602 } });
  expect((await flow.token({ token: narrowed.refresh_token, token_type_hint: "refresh_token" })).status).toBe(200);
  expect((await rpc(flow.env, narrowed.access_token)).status).toBe(401);
  expect((await flow.token({ ...refresh, resource, refresh_token: narrowed.refresh_token })).status).toBe(400);
});

it.each(["/account/key", "/account/key/delete", "/account/disconnect", "admission"])("refuses a refresh and a new MCP call after %s, regardless of provider KV", async path => {
  const flow = await clientFlow(keys);
  const tokens = await flow.connect("fixture-prior-key", true);
  const kv = flow.env.OAUTH_KV;
  const entries = (await Promise.all(["grant:", "token:"].map(async prefix => {
    const { keys } = await kv.list({ prefix });
    return Promise.all(keys.map(async ({ name }) => [name, (await kv.get(name))!] as const));
  }))).flat();
  if (path === "admission") flow.env.OIDC_ALLOWED_CLAIM_VALUES = '["other"]';
  else expect((await flow.visit(path, flow.form({ key: "fixture-next-key", generation: "1" }))).status).toBe(303);
  for (const [key, value] of entries) await kv.put(key, value);
  const stale = await rpc(flow.env, tokens.access_token);
  expect(stale.status).toBe(401);
  expect(await stale.json()).toMatchObject({ account: flow.env.PUBLIC_ORIGIN + "/account" });
  const response = await flow.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  expect((await rpc(flow.env, tokens.access_token)).status).toBe(401);
});

it("rejects another user's grant props and an incorrect verified audience before fetching", async () => {
  const a = await clientFlow(keys, "one");
  await a.connect("fixture-first");
  const b = await clientFlow(keys, "two");
  const { access_token } = await b.connect("fixture-second");
  const accounts = await b.env.DB.prepare("SELECT id, subject FROM accounts ORDER BY subject").all<{ id: string; subject: string }>();
  const [first, second] = accounts.results;
  const [grant] = await createStore(b.env.DB).listGrants(second.id);
  const goodProps = { accountId: second.id, appGrantId: grant.id, credentialVersion: 1, authorizationEpoch: 0 };
  const goodAuth = { userId: second.id, clientId: b.clientId, audience: resource, scope: ["capy:read"], token: access_token };
  vi.stubGlobal("fetch", vi.fn());
  for (const [props, auth] of [
    [goodProps, { ...goodAuth, userId: first.id }], [{ ...goodProps, accountId: first.id }, { ...goodAuth, userId: first.id }],
    [goodProps, { ...goodAuth, audience: resource + "/other" }], [goodProps, { ...goodAuth, clientId: a.clientId }],
    [{ ...goodProps, credentialVersion: "1" }, goodAuth],
  ]) {
    const ctx = Object.assign(createExecutionContext(), { props, auth }) as OAuthResourceContext<unknown>;
    expect((await handleMcp(new Request(resource, { method: "POST" }), b.env, ctx)).status).toBe(401);
  }
  expect(fetch).not.toHaveBeenCalled();
});
