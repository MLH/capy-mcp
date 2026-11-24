import { parseHostedConfig, parseHostedIdentityConfig } from "./hosted/config.js";
import { createHostedProvider } from "./hosted/oauth.js";
import { BodyLimitError, boundedBody } from "./hosted/http.js";
import { authAllowed } from "./hosted/browser.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/mcp") parseHostedIdentityConfig(env);
      else parseHostedConfig(env);
      if (url.origin !== env.PUBLIC_ORIGIN || path.startsWith("/mcp") && request.url !== env.PUBLIC_ORIGIN + "/mcp") {
        return new Response("Not found", { status: 404 });
      }
      if (path === "/mcp" && request.method === "OPTIONS") request = new Request(request.url, {
        method: "GET", headers: request.headers, signal: request.signal,
      });
      if (request.url.length > 8_192) return new Response("URL too long", { status: 414 });
      if (path === "/authorize" || path === "/register" || path === "/token") {
        if (request.method !== "OPTIONS" && !await authAllowed(request, env)) return new Response("Too many requests", { status: 429 });
        if (path !== "/authorize" && request.method === "POST") {
          let body;
          try {
            body = await boundedBody(request, 32_768, AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]));
          } catch (error) {
            return new Response("Invalid protocol request", { status: error instanceof BodyLimitError ? 413 : 400 });
          }
          if (path === "/token") {
            const form = new URLSearchParams(new TextDecoder().decode(body));
            if (["authorization_code", "refresh_token"].includes(form.get("grant_type") ?? "") &&
                (form.getAll("resource").length !== 1 || form.get("resource") !== env.PUBLIC_ORIGIN + "/mcp")) {
              return Response.json({ error: "invalid_target" }, { status: 400, headers: { "Cache-Control": "no-store" } });
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
      return new Response("Invalid server configuration", { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
