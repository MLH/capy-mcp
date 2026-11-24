import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { randomState } from "openid-client";
import { admit, parseHostedConfig } from "./config.js";
import { hashOpaqueId } from "./crypto.js";
import { BodyTooLarge, readBoundedBody } from "./http.js";
import { finishIdentityLogin, OIDC_CALLBACK_PATH, startIdentityLogin } from "./identity.js";
import { createStore, type Account, type BrowserSession } from "./store.js";

export type InternalContinuation = { kind: "account" } | { kind: "authorize"; transactionId: string };
type SessionContext = { account: Account; session: BrowserSession };
type MutationContext = SessionContext & { form: URLSearchParams };

const loginCookie = "__Host-capy-login";
const sessionCookie = "__Host-capy-session";
const csrfCookie = "__Host-capy-csrf";
const loginSeconds = 600;
const sessionSeconds = 3_600;
const maxFormBytes = 16_384;
const maxUrlLength = 8_192;
const maxCookieLength = 8_192;
const encoder = new TextEncoder();

export function browserResponse(body: string | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(body, { ...init, headers });
}

function errorResponse(status: number, message: string): Response {
  return browserResponse(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function redirect(location: string, ...cookies: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return browserResponse(null, { status: 303, headers });
}

function opaque(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie || cookie.length > maxCookieLength) return null;
  const values = cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith(name + "="));
  const value = values.length === 1 ? values[0].slice(name.length + 1) : null;
  return opaque(value) ? value : null;
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function parseContinuation(value: unknown): InternalContinuation | null {
  if (!value || typeof value !== "object" || !("kind" in value) || !Object.hasOwn(value, "kind")) return null;
  const keys = Object.keys(value);
  if (value.kind === "account" && keys.length === 1) return { kind: "account" };
  if (value.kind === "authorize" && keys.length === 2 && "transactionId" in value &&
      typeof value.transactionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.transactionId) &&
      Object.hasOwn(value, "transactionId")) {
    return { kind: "authorize", transactionId: value.transactionId };
  }
  return null;
}

async function limited(request: Request, env: Env): Promise<Response | null> {
  const ip = request.cf && !request.headers.has("CF-Worker") ? request.headers.get("CF-Connecting-IP") : null;
  const key = ip && ip.length <= 45 && isIP(ip) ? `ip:${ip}` : "anonymous";
  const { success } = await env.AUTH_RATE_LIMITER.limit({ key });
  return success ? null : errorResponse(429, "Too many requests.");
}

export async function beginLogin(request: Request, env: Env, continuation: InternalContinuation): Promise<Response> {
  try {
    const rejection = await limited(request, env);
    if (rejection) return rejection;
    if (request.method !== "GET") return errorResponse(405, "Method not allowed.");
    const config = parseHostedConfig(env);
    const origin = request.headers.get("Origin");
    const resume = parseContinuation(continuation);
    if (!resume || request.url.length > maxUrlLength || new URL(request.url).origin !== config.publicOrigin ||
        (origin !== null && origin !== config.publicOrigin)) return errorResponse(400, "Sign-in failed.");

    const { state, nonce, verifier, location } = await startIdentityLogin(config, request.signal);
    const browser = randomState();
    await createStore(env.DB).createLogin({
      stateHash: await hashOpaqueId(state), browserHash: await hashOpaqueId(browser),
      verifier, nonce, continuation: JSON.stringify(resume), expiresAt: Date.now() + loginSeconds * 1_000,
    });
    return redirect(location.href, setCookie(loginCookie, browser, loginSeconds));
  } catch {
    return errorResponse(400, "Sign-in failed.");
  }
}

export async function finishLogin(request: Request, env: Env): Promise<Response> {
  const failed = () => errorResponse(400, "Sign-in failed.");
  let consumed = false;
  const clearLogin = setCookie(loginCookie, "", 0);
  try {
    const rejection = await limited(request, env);
    if (rejection) return rejection;
    if (request.method !== "GET") return errorResponse(405, "Method not allowed.");
    if (request.url.length > maxUrlLength) return failed();
    const config = parseHostedConfig(env);
    const callback = new URL(request.url);
    if (callback.origin !== config.publicOrigin || callback.pathname !== OIDC_CALLBACK_PATH) return failed();
    const browser = readCookie(request, loginCookie);
    const states = callback.searchParams.getAll("state");
    if (!browser || states.length !== 1 || !opaque(states[0])) return failed();
    const state = states[0];
    const store = createStore(env.DB);
    const login = await store.consumeLogin(await hashOpaqueId(state), await hashOpaqueId(browser));
    if (!login) return failed();
    consumed = true;
    const resume = login.continuation && login.continuation.length <= 256 ? parseContinuation(JSON.parse(login.continuation)) : null;
    const codes = callback.searchParams.getAll("code");
    if (!resume || JSON.stringify(resume) !== login.continuation ||
        codes.length !== 1 || !codes[0] || codes[0].length > 4_096) throw new Error("Invalid callback");

    const identity = await finishIdentityLogin(config, callback, request.signal, state, login.nonce, login.verifier);
    if (!admit(identity, config)) {
      const response = errorResponse(403, "Sign-in not allowed.");
      response.headers.append("Set-Cookie", clearLogin);
      return response;
    }
    const account = await store.getOrCreateAccount(identity);
    const previous = readCookie(request, sessionCookie);
    const session = randomState();
    const csrf = randomState();
    if (previous) await store.deleteSession(previous);
    await store.createSession(session, {
      accountId: account.id, csrfHash: await hashOpaqueId(csrf), expiresAt: Date.now() + sessionSeconds * 1_000,
    });
    const location = resume.kind === "account" ? "/account" : `/oauth/resume?transaction=${resume.transactionId}`;
    return redirect(location, clearLogin, setCookie(sessionCookie, session, sessionSeconds), setCookie(csrfCookie, csrf, sessionSeconds));
  } catch {
    const response = failed();
    if (consumed) response.headers.append("Set-Cookie", clearLogin);
    return response;
  }
}

export async function requireSession(request: Request, env: Env): Promise<SessionContext | Response> {
  try {
    const config = parseHostedConfig(env);
    if (request.url.length > maxUrlLength || new URL(request.url).origin !== config.publicOrigin) {
      return errorResponse(403, "Request not allowed.");
    }
    const id = readCookie(request, sessionCookie);
    const store = createStore(env.DB);
    const session = id ? await store.getSession(id) : null;
    const account = session ? await store.getAccount(session.accountId) : null;
    if (!session || !account) return errorResponse(401, "Sign-in required.");
    if (!admit(account.identity, config)) return errorResponse(403, "Sign-in not allowed.");
    return { account, session };
  } catch {
    return errorResponse(503, "Sign-in unavailable.");
  }
}

async function matchesCsrf(token: unknown, session: BrowserSession): Promise<boolean> {
  if (!opaque(token) || !/^[0-9a-f]{64}$/.test(session.csrfHash)) return false;
  return timingSafeEqual(encoder.encode(await hashOpaqueId(token)), encoder.encode(session.csrfHash));
}

export async function csrfToken(request: Request, session: BrowserSession): Promise<string | null> {
  const token = readCookie(request, csrfCookie);
  return await matchesCsrf(token, session) ? token : null;
}

export async function requireMutation(request: Request, env: Env): Promise<MutationContext | Response> {
  if (request.method !== "POST") return errorResponse(405, "Method not allowed.");
  if (request.headers.get("Origin") !== env.PUBLIC_ORIGIN) return errorResponse(403, "Request not allowed.");
  const context = await requireSession(request, env);
  if (context instanceof Response) return context;
  try {
    const { success } = await env.ACCOUNT_RATE_LIMITER.limit({ key: context.account.id });
    if (!success) return errorResponse(429, "Too many requests.");
    const contentType = request.headers.get("Content-Type") ?? "";
    if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(contentType)) {
      return errorResponse(415, "Unsupported form type.");
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
    const bytes = await readBoundedBody(request, maxFormBytes, signal);
    const form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const tokens = form.getAll("csrf");
    if (tokens.length !== 1 || !await matchesCsrf(tokens[0], context.session)) return errorResponse(403, "Request not allowed.");
    return { ...context, form };
  } catch (error) {
    return error instanceof BodyTooLarge ? errorResponse(413, "Form too large.") : errorResponse(400, "Request failed.");
  }
}

export async function logout(request: Request, env: Env): Promise<Response> {
  try {
    const rejection = await limited(request, env);
    if (rejection) return rejection;
    const context = await requireMutation(request, env);
    if (context instanceof Response) return context;
    const id = readCookie(request, sessionCookie);
    if (!id) return errorResponse(401, "Sign-in required.");
    await createStore(env.DB).deleteSession(id);
    return redirect("/account", setCookie(sessionCookie, "", 0), setCookie(csrfCookie, "", 0), setCookie(loginCookie, "", 0));
  } catch {
    return errorResponse(503, "Sign-out unavailable.");
  }
}
