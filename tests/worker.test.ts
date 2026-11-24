import { exports } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectOperations } from "../src/catalog.js";
import worker from "../src/worker.js";
import wranglerSource from "../wrangler.jsonc?raw";

const credentials = { CAPY_API_KEY: "test-upstream-key", MCP_AUTH_TOKEN: "test-mcp-token" };
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "worker-test", version: "1" } } };
const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "capy_issues_list", arguments: { query: { limit: 1 } } } };

function request(body: unknown = list, headers: Record<string, string> = {}, method = "POST", path = "/mcp") {
  return new Request(`https://private.example${path}`, {
    method,
    headers: { authorization: "Bearer test-mcp-token", accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-11-25", ...headers },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

function serve(req = request(), env: Partial<Env> = credentials) {
  return worker.fetch(req, env as Env);
}

describe("private Worker in workerd", () => {
  beforeEach(() => { vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upstream request")); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("provides a reachable self-hosted default while preserving private access configuration", () => {
    const config = JSON.parse(wranglerSource);
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
    expect(config.secrets.required).toEqual(["CAPY_API_KEY", "MCP_AUTH_TOKEN", "OIDC_CLIENT_SECRET", "CREDENTIAL_ENCRYPTION_KEY"]);
    expect(config.vars.MCP_ALLOWED_ORIGINS).toBe("");
  });

  it("initializes through the configured Worker entry with finite JSON and no session", async () => {
    const response = await exports.default.fetch(request(initialize));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.has("mcp-session-id")).toBe(false);
    expect(await response.json()).toMatchObject({ id: 1, result: { serverInfo: { name: "capy-mcp" }, capabilities: { tools: {} } } });
    const discovery = await exports.default.fetch(request(list));
    expect(await discovery.json()).toMatchObject({ result: { tools: selectOperations().map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists all 102 tools by default and filters configured groups", async () => {
    const response = await serve();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 2, result: { tools: selectOperations().map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) } });
    const filtered = await serve(request(), { ...credentials, CAPY_TOOL_GROUPS: "captains,issues" });
    const value = await filtered.json() as { result: { tools: { name: string }[] } };
    expect(value.result.tools.map((tool) => tool.name)).toEqual(selectOperations("captains,issues").map((tool) => tool.name));
  });

  it("supports the official MCP HTTP client negotiation and finite tool calls", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ issues: [] }));
    const client = new Client({ name: "official-worker-client", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("https://private.example/mcp"), {
      requestInit: { headers: { authorization: "Bearer test-mcp-token" } },
      fetch: async (input, init) => serve(new Request(input, init)),
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(102);
      expect((await client.callTool({ name: "capy_issues_list" })).structuredContent).toEqual({ issues: [] });
    } finally {
      await client.close();
    }
  });

  it("executes a schema-validated tool with the upstream key rather than the MCP token", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ issues: [{ code: "CAP-1" }], nextCursor: "next" }));
    const response = await serve(request(call));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 3, result: { structuredContent: { issues: [{ code: "CAP-1" }], nextCursor: "next" } } });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(expect.any(URL), expect.objectContaining({ headers: { authorization: "Bearer test-upstream-key", accept: "application/json" } }));
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe("https://api.capy.ai/api/v1/issues?limit=1");
  });

  it.each(["", "Bearer wrong", "Bearer test-upstream-key", "Basic test-mcp-token", "Bearer test-mcp-token extra"])("returns 401 before upstream work for authorization %s", async (authorization) => {
    const response = await serve(request(call, { authorization }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(await response.text()).not.toContain(credentials.CAPY_API_KEY);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {}, { CAPY_API_KEY: "key" }, { MCP_AUTH_TOKEN: "token" },
    { ...credentials, MCP_AUTH_TOKEN: "" }, { ...credentials, CAPY_API_KEY: " " },
    { ...credentials, CAPY_API_KEY: "bad\nkey" },
    { ...credentials, MCP_AUTH_TOKEN: "bad token" },
    { CAPY_API_KEY: "test-mcp-token", MCP_AUTH_TOKEN: "test-mcp-token" },
  ])("fails closed for missing, invalid, or equal credentials %j", async (env) => {
    const response = await serve(request(call), env);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Invalid server configuration");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("authenticates before parsing invalid groups or origins", async () => {
    const response = await serve(request(call, { authorization: "Bearer wrong" }), { ...credentials, CAPY_TOOL_GROUPS: "invalid", MCP_ALLOWED_ORIGINS: "*" });
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unauthorized clients before reading their POST bodies", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull() { pulls++; throw new Error("Body must not be read"); } }, { highWaterMark: 0 });
    const response = await serve(new Request(request(call, { authorization: "Bearer wrong" }), { body: stream }));
    expect(response.status).toBe(401);
    expect(pulls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["https://browser.example", "null", ""])("denies browser Origin %s by default", async (origin) => {
    expect((await serve(request(call, { origin }))).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts only exact allowed origins without permissive CORS", async () => {
    const env = { ...credentials, MCP_ALLOWED_ORIGINS: "https://browser.example,http://localhost:3000" };
    const response = await serve(request(list, { origin: "https://browser.example" }), env);
    expect(response.status).toBe(200);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    for (const origin of ["https://browser.example.evil", "https://browser.example:444", "http://browser.example", "https://browser.example/", "https://BROWSER.example", "null"]) {
      const denied = await serve(request(call, { origin }), env);
      expect(denied.status).toBe(403);
      expect(denied.headers.has("access-control-allow-origin")).toBe(false);
    }
    expect((await serve(request(list, { origin: "http://localhost:3000" }), env)).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["*", "null", "https://browser.example/", "https://user:pass@browser.example", "https://browser.example/path", "https://browser.example?x=1", "https://browser.example#hash", "https://browser.example,", " https://browser.example "])("fails closed for malformed origin configuration %s", async (origins) => {
    expect((await serve(request(), { ...credentials, MCP_ALLOWED_ORIGINS: origins })).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["", "unknown", "captains,"])("fails closed for group configuration %s", async (groups) => {
    expect((await serve(request(), { ...credentials, CAPY_TOOL_GROUPS: groups })).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["/", "/mcp/", "/other"])("returns 404 for unknown route %s", async (path) => {
    expect((await serve(request(call, {}, "POST", path))).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["GET", "DELETE", "PUT", "OPTIONS", "HEAD"])("returns 405 with Allow for unsupported stateless method %s", async (method) => {
    const response = await serve(request(undefined, {}, method));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("acknowledges notifications and rejects invalid media, protocol, and JSON", async () => {
    expect((await serve(request({ jsonrpc: "2.0", method: "notifications/initialized" }))).status).toBe(202);
    expect((await serve(request(list, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await serve(request(list, { accept: "text/plain" }))).status).toBe(406);
    expect((await serve(request(list, { "mcp-protocol-version": "invalid" }))).status).toBe(400);
    const malformed = request();
    expect((await serve(new Request(malformed, { body: "invalid-json-secret" }))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([true, false])("rejects a body above 1 MiB before JSON parsing (declared length %s)", async (declared) => {
    const req = request(list, declared ? { "content-length": String(1024 * 1024 + 1) } : {});
    const oversized = new Request(req, { body: "x".repeat(1024 * 1024 + 1) });
    const response = await serve(oversized);
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("1048576");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds a chunked body without content length and stops reading after overflow", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(256 * 1024)); } }, { highWaterMark: 0 });
    const response = await serve(new Request(request(), { body: stream }));
    expect(response.status).toBe(413);
    expect(pulls).toBeLessThanOrEqual(6);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a valid JSON body exactly at the 1 MiB limit", async () => {
    const json = JSON.stringify(list);
    const response = await serve(new Request(request(), { body: json + " ".repeat(1024 * 1024 - json.length) }));
    expect(response.status).toBe(200);
  });

  it("runs generated validators without dynamic evaluation and never executes invalid or disabled tools", async () => {
    for (const [body, env] of [
      [{ ...call, params: { ...call.params, arguments: { query: { limit: 0 } } } }, credentials],
      [call, { ...credentials, CAPY_TOOL_GROUPS: "captains" }],
    ] as const) {
      const response = await serve(request(body), env);
      expect(await response.json()).toMatchObject({ error: { code: -32602 } });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never exposes upstream exceptions, credentials, or failure bodies", async () => {
    const log = vi.spyOn(console, "log");
    const errorLog = vi.spyOn(console, "error");
    vi.mocked(fetch).mockRejectedValueOnce(new Error("test-upstream-key test-mcp-token private payload"));
    const exception = await serve(request(call));
    expect(await exception.json()).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "network_error" } } } });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ message: "test-upstream-key test-mcp-token private payload", _tag: "capy/Forbidden" }, { status: 403 }));
    const response = await serve(request(call));
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "http_error", status: 403, tag: "capy/Forbidden" } } } });
    expect(text).not.toMatch(/test-upstream-key|test-mcp-token|private payload/);
    expect(log).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("isolates concurrent requests with different environment keys, groups, and tokens", async () => {
    const requests: string[] = [];
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const key = new Headers(init?.headers).get("authorization")!;
      requests.push(key);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ principal: key });
    });
    const responses = await Promise.all(["one", "two"].map((suffix) => serve(request(call, { authorization: `Bearer token-${suffix}` }), { CAPY_API_KEY: `key-${suffix}`, MCP_AUTH_TOKEN: `token-${suffix}`, CAPY_TOOL_GROUPS: "issues" })));
    expect(await Promise.all(responses.map((response) => response.json()))).toMatchObject([
      { result: { structuredContent: { principal: "Bearer key-one" } } },
      { result: { structuredContent: { principal: "Bearer key-two" } } },
    ]);
    expect(requests.sort()).toEqual(["Bearer key-one", "Bearer key-two"]);
    expect((await serve(request(call, { authorization: "Bearer token-one" }), { CAPY_API_KEY: "key-two", MCP_AUTH_TOKEN: "token-two" })).status).toBe(401);
    const lists = await Promise.all(["captains", "issues"].map(async (group) => {
      const response = await serve(request(list), { ...credentials, CAPY_TOOL_GROUPS: group });
      return await response.json();
    }));
    expect(lists).toEqual(["captains", "issues"].map((group) => ({ jsonrpc: "2.0", id: 2, result: { tools: selectOperations(group).map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) } })));
  });

  it.each(["headers", "body"])("settles an HTTP abort during upstream %s without cancelling another active request", async (phase) => {
    const controller = new AbortController();
    let started!: () => void;
    let otherStarted!: () => void;
    let releaseOther!: (response: Response) => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const otherReady = new Promise<void>((resolve) => { otherStarted = resolve; });
    const otherResponse = new Promise<Response>((resolve) => { releaseOther = resolve; });
    let abortedSignal: AbortSignal | null | undefined;
    let otherSignal: AbortSignal | null | undefined;
    let bodyCancelled = false;
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      if (new Headers(init?.headers).get("authorization") === "Bearer other-key") {
        otherSignal = init?.signal;
        otherStarted();
        return otherResponse;
      }
      abortedSignal = init?.signal;
      if (phase === "headers") {
        started();
        return new Promise<Response>(() => {});
      }
      return new Response(new ReadableStream({
        pull() { started(); },
        cancel() { bodyCancelled = true; },
      }, { highWaterMark: 0 }));
    });
    const pending = serve(new Request(request(call), { signal: controller.signal }));
    const other = serve(request(call), { ...credentials, CAPY_API_KEY: "other-key" });
    await Promise.all([ready, otherReady]);
    controller.abort(new Error("private abort reason"));
    await expect.poll(() => abortedSignal?.aborted, { timeout: 500 }).toBe(true);
    const response = await pending;
    expect(await response.json()).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "cancelled" } } } });
    if (phase === "body") expect(bodyCancelled).toBe(true);
    expect(otherSignal?.aborted).toBe(false);
    releaseOther(Response.json({ issues: [{ code: "CAP-2" }] }));
    expect(await (await other).json()).toMatchObject({ result: { structuredContent: { issues: [{ code: "CAP-2" }] } } });
    expect(otherSignal?.aborted).toBe(false);
  }, 2_000);

  it("settles pre-aborted HTTP calls without upstream work or exposing the abort reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("private abort reason"));
    const response = await serve(new Request(request(call), { signal: controller.signal }));
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "cancelled" } } } });
    expect(text).not.toContain("private abort reason");
    expect(fetch).not.toHaveBeenCalled();
  });
});
