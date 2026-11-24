import { AuthorizationError, authorizationErrorRedirect, getOAuthApi, GrantType, OAuthError, OAuthProvider, type OAuthHelpers, type OAuthProviderOptions, type OAuthResourceContext } from "./generated-provider/oauth-provider.js";
import { beginLogin, browserResponse, csrfToken, finishLogin, logout, requireMutation, requireSession } from "./browser.js";
import { handleAccount } from "./account.js";
import { connectForConsent, consentComplete, consentPage } from "./pages.js";
import { transactions } from "./transactions.js";
import { createStore } from "./store.js";
import { currentCredential, grantProps, handleMcp } from "./mcp.js";

const scopes = ["capy:read", "capy:write", "offline_access"];
const problem = (status: number, headers?: Headers) => browserResponse("Authorization could not be completed. Start again in your MCP client.", { status, headers });

export async function handleAuthorization(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const url = new URL(request.url);
  const store = createStore(env.DB);
  const pending = transactions(env.DB);
  if (url.pathname === "/consent") {
    const user = await requireMutation(request, env);
    if (user instanceof Response) return user;
    const { form, account, session } = user;
    const handle = form.get("handle");
    const decision = form.get("decision");
    if (!handle || !/^[\w-]{43}$/.test(handle) || decision !== "allow" && decision !== "deny" ||
        [...form.keys()].some(k => !["csrf", "handle", "decision", "write"].includes(k) || form.getAll(k).length !== 1) ||
        form.has("write") && form.get("write") !== "yes") return problem(400);
    const result = decision === "deny" ? await oauth.denyConsent(request, handle) :
      { ...await oauth.approveConsent(request, handle), redirectTo: null };
    let appGrantId: string | undefined;
    try {
      const snapshot = await pending.consume(handle, session.csrfHash, account.id);
      if (!snapshot) {
        result.headers.delete("Location");
        return problem(409, result.headers);
      }
      if (result.redirectTo !== null) return consentComplete(result.redirectTo, result.headers);
      const approved = result.request;
      if (form.has("write") && !approved.scope.includes("capy:write")) return problem(400, result.headers);
      const scope = approved.scope.filter(s => s !== "capy:write" || form.has("write"));
      appGrantId = crypto.randomUUID();
      const { credentialVersion, authorizationEpoch } = snapshot;
      const props = { accountId: account.id, appGrantId, credentialVersion, authorizationEpoch };
      if (!await store.createGrant({
        id: appGrantId, accountId: account.id, providerGrantId: "pending:" + appGrantId, clientId: approved.clientId,
        scopes: scope, credentialVersion, authorizationEpoch, revokedAt: null,
      }, credentialVersion, authorizationEpoch, snapshot.label)) return problem(409, result.headers);
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved, userId: account.id, metadata: {}, scope, props, revokeExistingGrants: false,
      });
      return consentComplete(redirectTo, result.headers);
    } catch {
      if (appGrantId) await store.revokeGrant(account.id, appGrantId).catch(() => {});
      result.headers.delete("Location");
      return problem(503, result.headers);
    }
  }

  if (request.method !== "GET") return problem(405);
  const user = await requireSession(request, env);
  if (user instanceof Response && user.status !== 401) return user;
  const id = url.searchParams.get("transaction");
  let auth;
  if (url.pathname === "/authorize") {
    if (url.searchParams.size > 32 || [...url.searchParams.keys()].some(k => url.searchParams.getAll(k).length !== 1)) return problem(400);
    auth = await oauth.parseAuthRequest(request);
    const error = url.searchParams.get("resource") !== env.PUBLIC_ORIGIN + "/mcp" ? "invalid_target" :
      auth.codeChallengeMethod !== "S256" || !/^[\w-]{43}$/.test(auth.codeChallenge ?? "") ? "invalid_request" :
      auth.scope.some(s => !scopes.includes(s)) ? "invalid_scope" : null;
    if (error) return consentComplete(authorizationErrorRedirect(auth, error), new Headers());
    auth.scope = [...new Set(["capy:read", ...auth.scope])];
    if (user instanceof Response) {
      const transactionId = await pending.start(auth, null);
      return beginLogin(request, env, { kind: "authorize", transactionId });
    }
  } else if (url.pathname !== "/oauth/resume" || !id || !/^[0-9a-f-]{36}$/.test(id) || url.searchParams.size !== 1) {
    return problem(400);
  }
  if (user instanceof Response) return user;
  const { session } = user;
  const csrf = await csrfToken(request, session);
  if (!csrf) return problem(403);
  const { connected } = await store.getAccountConnection(user.account.id);
  if (!auth && id) auth = await pending.resume(id, session.csrfHash, connected);
  if (!auth) return problem(400);
  if (!connected) {
    const transactionId = url.pathname === "/oauth/resume" ? id! : await pending.start(auth, session.csrfHash);
    if (!await pending.showOnboarding(transactionId, session.csrfHash, user.account)) return problem(409);
    return connectForConsent(csrf, transactionId);
  }
  const client = await oauth.describeConsent(auth);
  const consent = await oauth.beginConsent(auth);
  try {
    await pending.snapshot(consent.handle, session.csrfHash, user.account, client.clientName);
  } catch {
    return problem(503, consent.headers);
  }
  const page = consentPage(client, user.account.identity.subject, consent.handle, csrf);
  for (const [key, value] of consent.headers) {
    if (key.toLowerCase() === "set-cookie" || page.headers.get(key) !== value) page.headers.append(key, value);
  }
  return page;
}

async function cleanupGrants(env: Env, accountId: string) {
  const deadline = Date.now() + 5_000;
  let remaining = 48;
  const deletes: Promise<void>[] = [];
  function spend() {
    if (Date.now() >= deadline || remaining === 0) throw new Error("Cleanup budget exhausted");
    remaining--;
  }
  const kv = new Proxy(env.OAUTH_KV, { get(target, key) {
    if (key === "list") return (options: KVNamespaceListOptions) => {
      spend();
      if (remaining < 2) throw new Error("Cleanup budget exhausted");
      return target.list({ ...options, limit: Math.min(options.limit ?? 8, 8, remaining - 1) });
    };
    if (key === "delete") return (id: string) => {
      spend();
      const deleting = target.delete(id);
      deletes.push(deleting);
      return deleting;
    };
    throw new Error("Unsupported cleanup operation");
  } });
  const oauth = getOAuthApi(hostedOptions(env), { ...env, OAUTH_KV: kv });
  try {
    await createStore(env.DB).cleanupRevoked(accountId, (id, user) => oauth.revokeGrant(id, user));
  } finally {
    await Promise.allSettled(deletes);
  }
}

async function browserRoutes(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  const oauth = (env as Env & { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;
  if (path === "/auth/login") return beginLogin(request, env, { kind: "account" });
  if (path === "/auth/callback") return finishLogin(request, env);
  if (path === "/auth/logout") return logout(request, env);
  if (path === "/account" || path.startsWith("/account/")) return handleAccount(request, env, accountId => {
    ctx.waitUntil(cleanupGrants(env, accountId).catch(() => {}));
  });
  if (path === "/authorize" || path === "/oauth/resume" || path === "/consent") {
    try {
      return await handleAuthorization(request, env, oauth);
    } catch (error) {
      if (!(error instanceof AuthorizationError)) return problem(503);
      if (!error.redirectTo || !error.redirectUri) return problem(400);
      return consentComplete(authorizationErrorRedirect({ redirectUri: error.redirectUri, state: error.state, issuer: error.issuer }, error.code), new Headers());
    }
  }
  return new Response("Not found", { status: 404 });
}

function hostedOptions(env: Env): OAuthProviderOptions<Env> {
  const resource = env.PUBLIC_ORIGIN + "/mcp";
  return {
    apiRoute: resource,
    apiHandler: { fetch: (request, bindings, ctx) => handleMcp(request, bindings, ctx as OAuthResourceContext<unknown>) },
    defaultHandler: { fetch: browserRoutes },
    authorizeEndpoint: env.PUBLIC_ORIGIN + "/authorize",
    tokenEndpoint: env.PUBLIC_ORIGIN + "/token",
    clientRegistrationEndpoint: env.PUBLIC_ORIGIN + "/register",
    resourceMetadata: { resource },
    requiredScopes: ["capy:read"],
    scopesSupported: scopes,
    clientIdMetadataDocumentEnabled: true,
    onVerifiedRefreshRevocation: ({ env, userId, grantId, clientId }) =>
      createStore(env.DB).revokeVerifiedProviderGrant(userId, grantId, clientId),
    async tokenExchangeCallback({ env, grantType, props, resource: audience, userId, clientId, grantId, requestedScope }) {
      if (audience !== resource || !grantProps(props, userId) ||
          grantType === GrantType.AUTHORIZATION_CODE && !await createStore(env.DB).attachProviderGrant(userId, props.appGrantId, grantId, clientId) ||
          !await currentCredential(env, props, clientId, requestedScope, grantId)) {
        throw new OAuthError("invalid_grant", { description: "Reconnect and authorize this client again." });
      }
      if (grantType === GrantType.AUTHORIZATION_CODE && !requestedScope.includes("offline_access")) return { refreshTokenTTL: 0 };
    },
    onError: () => {},
  };
}

export function createHostedProvider(env: Env): OAuthProvider<Env> {
  return new OAuthProvider(hostedOptions(env));
}
