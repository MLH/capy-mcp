import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createCapyServer } from "./server.js";

async function secretsEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash, key] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, expectedHash);
  return crypto.subtle.verify("HMAC", key, signature, providedHash);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
    const { CAPY_API_KEY: apiKey, MCP_AUTH_TOKEN: authToken } = env;
    if (!apiKey || !authToken || !/^[\x21-\x7e]+$/.test(apiKey) || !/^[\x21-\x7e]+$/.test(authToken) || await secretsEqual(authToken, apiKey)) {
      return new Response("Invalid server configuration", { status: 503 });
    }
    const token = /^Bearer ([\x21-\x7e]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    if (!await secretsEqual(token, authToken)) {
      return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
    }

    const origins = env.MCP_ALLOWED_ORIGINS ? env.MCP_ALLOWED_ORIGINS.split(",") : [];
    try {
      for (const origin of origins) {
        const url = new URL(origin);
        if (!/^https?:$/.test(url.protocol) || url.origin !== origin) throw new Error("Invalid origin");
      }
    } catch {
      return new Response("Invalid server configuration", { status: 503 });
    }
    const origin = request.headers.get("origin");
    if (origin !== null && !origins.includes(origin)) return new Response("Forbidden origin", { status: 403 });
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    }

    let server;
    try {
      server = createCapyServer({ apiKey, groups: env.CAPY_TOOL_GROUPS }, { signal: request.signal });
    } catch {
      return new Response("Invalid server configuration", { status: 503 });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 1_048_576,
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
  },
} satisfies ExportedHandler<Env>;
