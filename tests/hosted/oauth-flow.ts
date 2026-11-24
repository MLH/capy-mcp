import { createExecutionContext } from "cloudflare:test";
import { expect, vi } from "vitest";
import worker from "../../src/worker.js";
import { browserOrigin, fakeIssuer } from "./fake-issuer.js";

export const resource = browserOrigin + "/mcp";
export const redirect = "https://client.example.invalid/callback";
const verifier = "fixture-verifier-".repeat(4);
export const serveHosted = (request: Request, env: Env) => worker.fetch(request, env, createExecutionContext());

export function completionTarget(response: Response): URL {
  const url = /^0; url="([^"]+)"$/.exec(response.headers.get("Refresh") ?? "")?.[1];
  if (!url) throw new Error("Missing consent completion navigation");
  return new URL(url);
}

export async function clientFlow(keys: CryptoKeyPair, subject = "member-1") {
  const oidc = await fakeIssuer(keys, { claims: { sub: subject } });
  const env = { ...oidc.env, ACCOUNT_RATE_LIMITER: { limit: async () => ({ success: true }) } };
  const issuerFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "https://api.capy.ai/api/v1/projects" && init?.method === "GET") return Promise.resolve(Response.json({ projects: [] }));
    return issuerFetch(input, init);
  });
  const cookies = new Map<string, string>();
  async function visit(path: string | URL, body?: URLSearchParams) {
    const response = await serveHosted(new Request(new URL(path, browserOrigin), {
      method: body ? "POST" : "GET", body,
      headers: { Cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; "), ...(body ? { Origin: browserOrigin } : {}) },
    }), env);
    for (const cookie of response.headers.getSetCookie()) {
      const [k, v] = cookie.split(";", 1)[0].split("=");
      if (v) cookies.set(k, v); else cookies.delete(k);
    }
    return response;
  }
  const registration = await serveHosted(new Request(browserOrigin + "/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "<b>Unverified</b>", redirect_uris: [redirect],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
  }), env);
  expect(registration.status).toBe(201);
  const { client_id: clientId } = await registration.json<{ client_id: string }>();
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=+$/, "").replaceAll("+", "-").replaceAll("/", "_");
  function authorize(overrides: Record<string, string> = {}) {
    return visit("/authorize?" + new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: redirect, resource,
      code_challenge: challenge, code_challenge_method: "S256", scope: "capy:read capy:write offline_access", state: "client-state", ...overrides,
    }));
  }
  async function signIn() {
    const start = await authorize();
    expect(start.status).toBe(303);
    const callback = oidc.callback(start);
    const finished = await visit(callback);
    expect(finished.status).toBe(303);
    return { callback, resume: finished.headers.get("Location")! };
  }
  function form(fields: Record<string, string>) {
    return new URLSearchParams({ csrf: cookies.get("__Host-capy-csrf")!, ...fields });
  }
  async function onboard(key: string) {
    const { resume } = await signIn();
    const page = await visit(resume);
    expect(page.status).toBe(200);
    const action = (await page.text()).match(/action="(\/account\/key[^"]*)"/)?.[1];
    expect(action).toBeTruthy();
    const connected = await visit(action!, form({ key }));
    expect(connected.status).toBe(303);
    expect(connected.headers.get("Location")).toBe(resume);
    return visit(resume);
  }
  async function decide(page: Response, decision = "allow", write = false) {
    const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)?.[1];
    expect(handle).toBeTruthy();
    return visit("/consent", form({ handle: handle!, decision, ...(write ? { write: "yes" } : {}) }));
  }
  function token(params: Record<string, string>) {
    return serveHosted(new Request(browserOrigin + "/token", { method: "POST",
      body: new URLSearchParams({ client_id: clientId, ...params }) }), env);
  }
  function exchange(code: string, fields: Record<string, string> = {}) {
    return token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect, resource, ...fields });
  }
  async function connect(key: string, write = false) {
    const authorized = await decide(await onboard(key), "allow", write);
    expect(authorized.status).toBe(200);
    const code = completionTarget(authorized).searchParams.get("code")!;
    const response = await exchange(code);
    expect(response.status).toBe(200);
    return response.json<{ access_token: string; refresh_token: string; scope: string }>();
  }
  return { env, visit, authorize, signIn, onboard, decide, token, exchange, connect, form, cookies, clientId };
}
