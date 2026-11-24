import { parseHostedConfig, parseHostedIdentityConfig } from "./hosted/config.js";
import { createHostedProvider } from "./hosted/oauth.js";
import { BodyLimitError, boundedBody } from "./hosted/http.js";
import { handleAccount } from "./hosted/account.js";
import { authAllowed, logout } from "./hosted/browser.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    function early(status: number, localMessage: string, error: string): Response {
      if (url.origin !== env.PUBLIC_ORIGIN || path !== "/token" && path !== "/register") return new Response(localMessage, { status });
      const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" });
      const origin = request.headers.get("Origin");
      if (origin) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Allow-Methods", "*");
        headers.set("Access-Control-Allow-Headers", "Authorization, *");
        headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, Retry-After");
      }
      return Response.json({ error }, { status, headers });
    }
    try {
      if (request.url === env.PUBLIC_ORIGIN + "/auth/logout") return logout(request, env);
      if (request.url === env.PUBLIC_ORIGIN + "/account" && request.method === "GET") return handleAccount(request, env);
      if (path === "/mcp") parseHostedIdentityConfig(env);
      else parseHostedConfig(env);
      if (url.origin !== env.PUBLIC_ORIGIN || path.startsWith("/mcp") && request.url !== env.PUBLIC_ORIGIN + "/mcp") {
        return new Response("Not found", { status: 404 });
      }
      if (path === "/mcp" && request.method === "OPTIONS") request = new Request(request.url, {
        method: "GET", headers: request.headers, signal: request.signal,
      });
      if (request.url.length > 8_192) return early(414, "URL too long", "invalid_request");
      if (path === "/authorize" || path === "/register" || path === "/token") {
        if (request.method !== "OPTIONS" && !await authAllowed(request, env)) return early(429, "Too many requests", "temporarily_unavailable");
        if (path !== "/authorize" && request.method === "POST") {
          let body;
          try {
            body = await boundedBody(request, 32_768, AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]));
          } catch (error) {
            return early(error instanceof BodyLimitError ? 413 : 400, "Invalid protocol request", "invalid_request");
          }
          if (path === "/token") {
            const form = new URLSearchParams(new TextDecoder().decode(body));
            if (["authorization_code", "refresh_token"].includes(form.get("grant_type") ?? "") &&
                (form.getAll("resource").length !== 1 || form.get("resource") !== env.PUBLIC_ORIGIN + "/mcp")) {
              return early(400, "Invalid target", "invalid_target");
            }
          }
          request = new Request(request, { body });
        }
      }
      const response = await createHostedProvider(env).fetch(request, { ...env }, ctx);
      if (path !== "/mcp" || !response.headers.has("Access-Control-Allow-Origin")) return response;
      const privateResponse = new Response(response.body, response);
      for (const key of [...privateResponse.headers.keys()]) if (key.startsWith("access-control-")) privateResponse.headers.delete(key);
      return privateResponse;
    } catch {
      return early(503, "Invalid server configuration", "server_error");
    }
  },
} satisfies ExportedHandler<Env>;
