import { selectOperations } from "../catalog.js";
import { callCapy, CapyError } from "../client.js";
import { browserResponse, csrfToken, requireMutation, requireSession } from "./browser.js";
import { parseHostedConfig } from "./config.js";
import { encryptCredential, isCredentialKey } from "./crypto.js";
import { accessDeniedPage, accountPage, confirmationPage, signInPage } from "./pages.js";
import { createStore } from "./store.js";
import { transactions } from "./transactions.js";

const projectsList = selectOperations().find(({ operationId }) => operationId === "projects.list");

export async function validateCapyKey(key: string, signal?: AbortSignal): Promise<void> {
  if (!isCredentialKey(key) || projectsList?.method !== "GET" || projectsList.route !== "/api/v1/projects") {
    throw new Error("Invalid Capy key validation request");
  }
  await callCapy(projectsList, {}, { apiKey: key, signal });
}

function problem(status: number, body: string, headers?: HeadersInit): Response {
  return browserResponse(body, { status, headers });
}

async function showAccount(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireSession(request, env);
  if (user instanceof Response) {
    if (url.origin === env.PUBLIC_ORIGIN) {
      if (user.status === 401) return signInPage();
      if (user.status === 403) return accessDeniedPage();
    }
    return user;
  }

  const csrf = await csrfToken(request, user.session);
  if (csrf === null) return problem(403, "Sign in again to manage your account.");
  const { connected, clients } = await createStore(env.DB).getAccountConnection(user.account.id);
  const confirmation = url.searchParams.get("confirm");
  if (confirmation === "delete" || confirmation === "disconnect") return confirmationPage({ kind: confirmation }, csrf);
  if (confirmation === "revoke") {
    const grant = clients.find(({ id }) => id === url.searchParams.get("grant"));
    if (!grant) return problem(404, "Client grant not found.");
    return confirmationPage({ kind: "revoke", id: grant.id, label: grant.label }, csrf);
  }
  return accountPage({
    subject: user.account.identity.subject,
    connected,
    clients: clients.map(({ id, label, scopes, createdAt }) => ({
      id, label, scopes, grantedAt: createdAt === null ? null : new Date(createdAt).toISOString(),
    })),
    csrf,
  });
}

export async function handleAccount(request: Request, env: Env, revokeProviderGrant?: (id: string, user: string) => Promise<void>): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/account") {
      return request.method === "GET" ? await showAccount(request, env, url) : problem(405, "Method not allowed.", { Allow: "GET" });
    }
    const revoke = /^\/account\/grants\/([\w-]{1,128})\/revoke$/.exec(path);
    if (!revoke && path !== "/account/key" && path !== "/account/key/delete" && path !== "/account/disconnect") {
      return problem(404, "Account page not found.");
    }
    if (request.method !== "POST") return problem(405, "Method not allowed.", { Allow: "POST" });
    const user = await requireMutation(request, env);
    if (user instanceof Response) return user;
    const { account, form } = user;
    const store = createStore(env.DB);
    let destination = "/account";

    if (path === "/account/key") {
      const [key, ...duplicates] = form.getAll("key");
      if (key === undefined || duplicates.length || !isCredentialKey(key)) return problem(400, "Enter a valid Capy API key.");
      form.delete("key");
      const id = url.searchParams.get("transaction");
      if (id !== null && (!/^[0-9a-f-]{36}$/.test(id) || url.searchParams.size !== 1)) return problem(400, "Invalid connection request.");
      const pending = transactions(env.DB);
      const expected = id === null ? account.credentialVersion : await pending.onboardingVersion(id, user.session.csrfHash, account.id);
      if (expected === null) return problem(409, "Connection request expired or changed. Start again.");
      const config = parseHostedConfig(env);
      try {
        await validateCapyKey(key, request.signal);
      } catch (error) {
        if (error instanceof CapyError && error.code === "http_error" && (error.status === 401 || error.status === 403)) {
          return problem(422, "Capy did not accept this key. Check the key and try again.");
        }
        return problem(503, "Could not validate the Capy key. Try again.");
      }
      const envelope = await encryptCredential(key, account.id, expected + 1, config.encryption);
      request.signal.throwIfAborted();
      const saved = id === null ? await store.putCredential(account.id, envelope, expected) :
        await pending.connect(id, user.session.csrfHash, account.id, envelope);
      if (!saved) return problem(409, "The Capy connection changed. Reload and try again.");
      if (id !== null) destination = "/oauth/resume?transaction=" + id;
    } else if (path === "/account/key/delete") {
      if (!await store.deleteCredential(account.id)) return problem(409, "No Capy key to remove.");
    } else if (revoke) {
      if (!await store.revokeGrant(account.id, revoke[1])) return problem(404, "Client grant not found.");
    } else if (!await store.disconnectAll(account.id)) {
      return problem(409, "The account changed. Reload and try again.");
    }

    if (revokeProviderGrant) await store.cleanupRevoked(account.id, revokeProviderGrant).catch(() => {});
    return browserResponse(null, { status: 303, headers: { Location: destination } });
  } catch {
    return problem(503, "Account operation unavailable.");
  }
}
