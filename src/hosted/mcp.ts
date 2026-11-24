import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createCapyServer } from "../server.js";
import { admit, parseHostedConfig } from "./config.js";
import { decryptCredential } from "./crypto.js";
import { createStore } from "./store.js";

export interface GrantProps {
  accountId: string;
  appGrantId: string;
  credentialVersion: number;
  authorizationEpoch: number;
}

export function grantProps(props: unknown, userId?: string): props is GrantProps {
  if (!props || typeof props !== "object" || Object.keys(props).length !== 4) return false;
  const p = props as Partial<GrantProps>;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  return typeof p.accountId === "string" && p.accountId === userId && uuid.test(p.accountId) &&
    typeof p.appGrantId === "string" && uuid.test(p.appGrantId) &&
    Number.isSafeInteger(p.credentialVersion) && p.credentialVersion! > 0 &&
    Number.isSafeInteger(p.authorizationEpoch) && p.authorizationEpoch! >= 0;
}

export async function currentCredential(env: Env, props: GrantProps, clientId: string, scopes: string[], providerGrantId?: string) {
  const config = parseHostedConfig(env);
  const current = await createStore(env.DB).getAuthorizedCredential(props.accountId, props.appGrantId,
    props.credentialVersion, props.authorizationEpoch, { clientId, scopes, providerGrantId });
  return current && admit(current.account.identity, config) ? { envelope: current.credential, config } : null;
}

export async function handleMcp(request: Request, env: Env, context: OAuthResourceContext<unknown>): Promise<Response> {
  const { props, auth } = context;
  const resource = env.PUBLIC_ORIGIN + "/mcp";
  const reconnect = () => Response.json({ error: "invalid_token", account: env.PUBLIC_ORIGIN + "/account",
    error_description: "Reconnect your Capy account and authorize the client again." }, { status: 401,
    headers: { "Cache-Control": "no-store", "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${env.PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp"` } });
  if (request.url !== resource || !grantProps(props, auth?.userId) || auth.audience !== resource || !auth.clientId) return reconnect();
  const current = await currentCredential(env, props, auth.clientId, auth.scope);
  if (!current) return reconnect();
  const origin = request.headers.get("Origin");
  if (origin !== null && !current.config.allowedOrigins.includes(origin)) return new Response("Forbidden origin", { status: 403 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  if (!auth.scope.includes("capy:read")) return new Response("Read permission required", { status: 403,
    headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="capy:read"' } });
  let apiKey;
  try {
    apiKey = await decryptCredential(current.envelope, props.accountId, current.config.encryption);
  } catch {
    return reconnect();
  }
  const server = createCapyServer({ apiKey, groups: current.config.groups }, {
    signal: request.signal, reconnectUrl: env.PUBLIC_ORIGIN + "/account",
    allowOperation: operation => operation.method === "GET" || auth.scope.includes("capy:write"),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 1_048_576,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch {
    return new Response("Internal server error", { status: 500 });
  } finally {
    await server.close();
    await transport.close();
  }
}
