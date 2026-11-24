import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { beginLogin, finishLogin } from "../../src/hosted/browser.js";
import { browserOrigin, entraIssuer, fakeIssuer, signingKey } from "./fake-issuer.js";
import { resetHostedDb } from "./setup.js";

let keys: CryptoKeyPair;
beforeAll(async () => { keys = await signingKey(); });
beforeEach(resetHostedDb);
afterEach(() => vi.unstubAllGlobals());

const login = () => new Request(`${browserOrigin}/login`);

it.each([
  ["metadata for a different tenant", { issuer: "https://login.microsoftonline.com/other-tenant/v2.0" }],
  ["authorization with a non-HTTPS scheme", { authorization_endpoint: "http://login.microsoftonline.com/auth" }],
  ["authorization with prefilled protocol parameters", { authorization_endpoint: "https://login.microsoftonline.com/authorize?redirect_uri=https://untrusted.invalid" }],
  ["authorization with URL credentials", { authorization_endpoint: "https://user@auth.example.invalid/authorize" }],
  ["token endpoint on a link-local address", { token_endpoint: "https://169.254.169.254/token" }],
  ["token endpoint on an IPv6 loopback address", { token_endpoint: "https://[::1]/token" }],
  ["JWKS on a local hostname", { jwks_uri: "https://service.localhost/jwks" }],
  ["JWKS with a fragment", { jwks_uri: "https://keys.example.invalid/jwks#fragment" }],
  ["metadata explicitly excluding S256", { code_challenge_methods_supported: ["plain"] }],
])("does not begin login with %s", async (_name, metadata) => {
  const issuer = await fakeIssuer(keys, { issuer: entraIssuer, metadata });
  const response = await beginLogin(login(), issuer.env, { kind: "account" });
  expect(response.status).toBe(400);
  expect(response.headers.has("Location")).toBe(false);
  expect(response.headers.has("Set-Cookie")).toBe(false);
  expect(issuer.requests).toEqual([`${entraIssuer}/.well-known/openid-configuration`]);
});

it("accepts public HTTPS endpoints on different origins from a trusted non-Google issuer", async () => {
  const issuer = await fakeIssuer(keys, {
    issuer: "https://issuer.example.invalid/region",
    endpoints: {
      authorization: "https://login.example.invalid/authorize?realm=engineering",
      token: "https://tokens.example.invalid/token?realm=engineering",
      jwks: "https://keys.example.invalid/jwks?realm=engineering",
    },
  });
  const start = await beginLogin(login(), issuer.env, { kind: "account" });
  expect(start.status).toBe(303);
  const target = new URL(start.headers.get("Location") ?? "");
  expect(target.origin + target.pathname).toBe("https://login.example.invalid/authorize");
  expect(target.searchParams.get("realm")).toBe("engineering");
  const cookie = start.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
  const callback = await finishLogin(new Request(issuer.callback(start), { headers: { cookie } }), issuer.env);
  expect(callback.status).toBe(303);
  expect(issuer.requests).toContain("https://tokens.example.invalid/token?realm=engineering");
  expect(issuer.requests).toContain("https://keys.example.invalid/jwks?realm=engineering");
});

it("does not perform discovery against a nonpublic configured issuer", async () => {
  const issuer = await fakeIssuer(keys, { issuer: "https://127.0.0.1" });
  const response = await beginLogin(login(), issuer.env, { kind: "account" });
  expect(response.status).toBe(400);
  expect(issuer.requests).toEqual([]);
});

it("never follows a discovery redirect, even on the issuer host", async () => {
  const issuer = await fakeIssuer(keys, { issuer: entraIssuer,
    discoveryResponse: () => Response.redirect("https://login.microsoftonline.com/redirect", 302),
  });
  const response = await beginLogin(login(), issuer.env, { kind: "account" });
  expect(response.status).toBe(400);
  expect(response.headers.has("Location")).toBe(false);
  expect(issuer.requests).toEqual([`${entraIssuer}/.well-known/openid-configuration`]);
});

it("never follows a token redirect carrying client credentials and verifier", async () => {
  const issuer = await fakeIssuer(keys, {
    tokenResponse: () => Response.redirect("https://untrusted.invalid/token", 307),
  });
  const start = await beginLogin(login(), issuer.env, { kind: "account" });
  expect(start.status).toBe(303);
  const cookie = start.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
  const response = await finishLogin(new Request(issuer.callback(start), { headers: { cookie } }), issuer.env);
  expect(response.status).toBe(400);
  expect(response.headers.has("Location")).toBe(false);
  expect(issuer.requests).not.toContain("https://untrusted.invalid/token");
});

it("cancels discovery once its streaming body crosses the byte limit", async () => {
  const cancelled = vi.fn();
  const issuer = await fakeIssuer(keys, {
    discoveryResponse: () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(262_145)); },
      cancel: cancelled,
    }), { headers: { "content-type": "application/json" } }),
  });
  const response = await beginLogin(login(), issuer.env, { kind: "account" });
  expect(response.status).toBe(400);
  expect(cancelled).toHaveBeenCalledOnce();
});

it("aborts a stalled identity response body when the incoming request disconnects", async () => {
  const client = new AbortController();
  const cancelled = vi.fn();
  const issuer = await fakeIssuer(keys, {
    discoveryResponse: () => new Response(new ReadableStream<Uint8Array>({
      pull() { client.abort(); },
      cancel: cancelled,
    }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } }),
  });
  const request = new Request(login(), { signal: client.signal });
  const response = await beginLogin(request, issuer.env, { kind: "account" });
  expect(response.status).toBe(400);
  expect(response.headers.has("Set-Cookie")).toBe(false);
  expect(cancelled).toHaveBeenCalledOnce();
});
