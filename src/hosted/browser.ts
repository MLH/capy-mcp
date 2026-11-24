import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { randomState } from "openid-client";
import { admit, parseHostedConfig } from "./config.js";
import { hashOpaqueId } from "./crypto.js";
import { BodyLimitError, boundedBody } from "./http.js";
import { authorizationStart, OIDC_CALLBACK_PATH, verifiedIdentity } from "./identity.js";
import { createStore, type Account, type BrowserSession } from "./store.js";
import { transactions } from "./transactions.js";

export type InternalContinuation = { kind: "account" } | { kind: "authorize"; transactionId: string };
type SignedIn = { account: Account; session: BrowserSession };

const loginCookie = "__Host-capy-login";
const sessionCookie = "__Host-capy-session";
const csrfCookie = "__Host-capy-csrf";
const loginLifetime = 600;
const sessionLifetime = 3_600;

export function browserResponse(body: string | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(body, { ...init, headers });
}

function problem(status: number, body: string, cookie?: string): Response {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return browserResponse(body, { status, headers });
}

function browserRedirect(location: string, ...cookies: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return browserResponse(null, { status: 303, headers });
}

function cookieValue(name: string, value = "", seconds = 0): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
}

function opaque(value: string | null): value is string {
  return value !== null && /^[\w-]{43}$/.test(value);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header || header.length > 8_192) return null;
  const prefix = name + "=";
  const matches = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(prefix));
  const value = matches.length === 1 ? matches[0].slice(prefix.length) : null;
  return opaque(value) ? value : null;
}

function parseContinuation(input: unknown): InternalContinuation | null {
  if (input === null || typeof input !== "object" || !("kind" in input) || !Object.hasOwn(input, "kind")) return null;
  const size = Object.keys(input).length;
  if (input.kind === "account" && size === 1) return { kind: "account" };
  if (input.kind !== "authorize" || size !== 2 || !("transactionId" in input) || !Object.hasOwn(input, "transactionId") ||
      typeof input.transactionId !== "string" || !/^[\w-]{1,128}$/.test(input.transactionId)) return null;
  return { kind: "authorize", transactionId: input.transactionId };
}

export async function authAllowed(request: Request, env: Env): Promise<boolean> {
  const ip = request.cf && !request.headers.has("CF-Worker") ? request.headers.get("CF-Connecting-IP") : null;
  const { success } = await env.AUTH_RATE_LIMITER.limit({
    key: ip && ip.length <= 45 && isIP(ip) !== 0 ? `ip:${ip}` : "anonymous",
  });
  return success;
}

function browserUrl(request: Request, publicOrigin: string): URL | null {
  if (request.url.length > 8_192) return null;
  const url = new URL(request.url);
  return url.protocol === "https:" && url.origin === publicOrigin ? url : null;
}

export async function beginLogin(request: Request, env: Env, continuation: InternalContinuation): Promise<Response> {
  try {
    if (!await authAllowed(request, env)) return problem(429, "Too many requests.");
    if (request.method !== "GET") return problem(405, "Method not allowed.");
    const config = parseHostedConfig(env);
    const origin = request.headers.get("Origin");
    const resume = parseContinuation(continuation);
    if (!resume || !browserUrl(request, config.publicOrigin) || (origin !== null && origin !== config.publicOrigin)) {
      return problem(400, "Sign-in failed.");
    }
    const authorization = await authorizationStart(config, request.signal);
    const binding = randomState();
    const [stateHash, browserHash] = await Promise.all([hashOpaqueId(authorization.state), hashOpaqueId(binding)]);
    await createStore(env.DB).createLogin({
      stateHash, browserHash, verifier: authorization.verifier, nonce: authorization.nonce,
      continuation: JSON.stringify(resume), expiresAt: Date.now() + loginLifetime * 1_000,
    });
    return browserRedirect(authorization.redirect.href, cookieValue(loginCookie, binding, loginLifetime));
  } catch {
    return problem(400, "Sign-in failed.");
  }
}

export async function finishLogin(request: Request, env: Env): Promise<Response> {
  let clearBinding: string | undefined;
  try {
    if (!await authAllowed(request, env)) return problem(429, "Too many requests.");
    if (request.method !== "GET") return problem(405, "Method not allowed.");
    const config = parseHostedConfig(env);
    const callback = browserUrl(request, config.publicOrigin);
    if (!callback || callback.pathname !== OIDC_CALLBACK_PATH) return problem(400, "Sign-in failed.");
    const [state, ...duplicates] = callback.searchParams.getAll("state");
    const binding = readCookie(request, loginCookie);
    if (!opaque(state ?? null) || duplicates.length || !binding) return problem(400, "Sign-in failed.");

    const store = createStore(env.DB);
    const [stateHash, browserHash] = await Promise.all([hashOpaqueId(state), hashOpaqueId(binding)]);
    const login = await store.consumeLogin(stateHash, browserHash);
    if (!login) return problem(400, "Sign-in failed.");
    clearBinding = cookieValue(loginCookie);
    const saved = login.continuation;
    const resume = saved && saved.length <= 256 ? parseContinuation(JSON.parse(saved)) : null;
    const codes = callback.searchParams.getAll("code");
    if (!resume || JSON.stringify(resume) !== saved || codes.length !== 1 || !codes[0] || codes[0].length > 4_096) {
      return problem(400, "Sign-in failed.", clearBinding);
    }

    const identity = await verifiedIdentity(config, callback, state, login, request.signal);
    if (!admit(identity, config)) {
      await store.updateExistingAdmission(identity);
      return problem(403, "Sign-in not allowed.", clearBinding);
    }
    const account = await store.getOrCreateAccount(identity);
    const prior = readCookie(request, sessionCookie);
    if (prior) await store.deleteSession(prior);
    const session = randomState();
    const csrf = randomState();
    const csrfHash = await hashOpaqueId(csrf);
    await store.createSession(session, {
      accountId: account.id, csrfHash, expiresAt: Date.now() + sessionLifetime * 1_000,
    });
    if (resume.kind === "authorize") await transactions(env.DB).bindLogin(resume.transactionId, csrfHash);
    const destination = resume.kind === "authorize" ? `/oauth/resume?transaction=${resume.transactionId}` : "/account";
    return browserRedirect(destination, clearBinding, cookieValue(sessionCookie, session, sessionLifetime),
      cookieValue(csrfCookie, csrf, sessionLifetime));
  } catch {
    return problem(400, "Sign-in failed.", clearBinding);
  }
}

export async function requireSession(request: Request, env: Env): Promise<SignedIn | Response> {
  try {
    const config = parseHostedConfig(env);
    if (!browserUrl(request, config.publicOrigin)) return problem(403, "Request not allowed.");
    const id = readCookie(request, sessionCookie);
    if (!id) return problem(401, "Sign-in required.");
    const store = createStore(env.DB);
    const session = await store.getSession(id);
    const account = session ? await store.getAccount(session.accountId) : null;
    if (!session || !account) return problem(401, "Sign-in required.");
    return admit(account.identity, config) ? { account, session } : problem(403, "Sign-in not allowed.");
  } catch {
    return problem(503, "Sign-in unavailable.");
  }
}

const utf8 = new TextEncoder();

async function validCsrf(value: string | null, session: BrowserSession): Promise<boolean> {
  return opaque(value) && /^[0-9a-f]{64}$/.test(session.csrfHash) &&
    timingSafeEqual(utf8.encode(await hashOpaqueId(value)), utf8.encode(session.csrfHash));
}

export async function csrfToken(request: Request, session: BrowserSession): Promise<string | null> {
  const cookie = readCookie(request, csrfCookie);
  return await validCsrf(cookie, session) ? cookie : null;
}

function rejectMutationRequest(request: Request, origin: string): Response | null {
  if (request.method !== "POST") return problem(405, "Method not allowed.");
  if (!browserUrl(request, origin) || request.headers.get("Origin") !== origin) return problem(403, "Request not allowed.");
  return null;
}

async function checkedForm(request: Request, env: Env, session: BrowserSession): Promise<URLSearchParams | Response> {
  try {
    const { success } = await env.ACCOUNT_RATE_LIMITER.limit({ key: session.accountId });
    if (!success) return problem(429, "Too many requests.");
    if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? "")) {
      return problem(415, "Unsupported form type.");
    }
    const bytes = await boundedBody(request, 16_384, AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]));
    const form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (form.getAll("csrf").length !== 1 || !await validCsrf(form.get("csrf"), session)) {
      return problem(403, "Request not allowed.");
    }
    return form;
  } catch (error) {
    return error instanceof BodyLimitError ? problem(413, "Form too large.") : problem(400, "Request failed.");
  }
}

export async function requireMutation(request: Request, env: Env): Promise<(SignedIn & { form: URLSearchParams }) | Response> {
  const rejection = rejectMutationRequest(request, env.PUBLIC_ORIGIN);
  if (rejection) return rejection;
  const user = await requireSession(request, env);
  if (user instanceof Response) return user;
  const form = await checkedForm(request, env, user.session);
  return form instanceof Response ? form : { ...user, form };
}

export async function logout(request: Request, env: Env): Promise<Response> {
  try {
    if (!await authAllowed(request, env)) return problem(429, "Too many requests.");
    const rejection = rejectMutationRequest(request, env.PUBLIC_ORIGIN);
    if (rejection) return rejection;
    const id = readCookie(request, sessionCookie);
    if (!id) return problem(401, "Sign-in required.");
    const store = createStore(env.DB);
    const session = await store.getSession(id);
    if (!session) return problem(401, "Sign-in required.");
    const form = await checkedForm(request, env, session);
    if (form instanceof Response) return form;
    await store.deleteSession(id);
    return browserRedirect("/account", cookieValue(sessionCookie), cookieValue(csrfCookie), cookieValue(loginCookie));
  } catch {
    return problem(503, "Sign-out unavailable.");
  }
}
