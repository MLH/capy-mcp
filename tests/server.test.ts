import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { selectOperations } from "../src/catalog.js";
import { createCapyServer } from "../src/server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });

async function connect(fetch: typeof globalThis.fetch = async () => Response.json({}), groups?: string) {
  const server = createCapyServer({ apiKey: "server-secret-key", groups }, { fetch });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("Capy MCP server", () => {
  it("initializes and advertises all 102 tools with the catalog schemas and annotations", async () => {
    const client = await connect();
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(102);
    expect(tools).toEqual(selectOperations().map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })));
  });

  it("advertises only enabled groups", async () => {
    const client = await connect(undefined, "captains,messages");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(selectOperations("captains,messages").map((tool) => tool.name));
  });

  it.each(["", "captains,", "unknown"])('fails closed for group configuration "%s"', (groups) => {
    expect(() => createCapyServer({ apiKey: "key", groups })).toThrow("Invalid CAPY_TOOL_GROUPS configuration");
  });

  it("creates a Captain then messages its thread, preserving explicit retry IDs", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const client = await connect(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json(requests.length === 1 ? { threadId: "jam_captain" } : { messageId: "msg_1" });
    });
    const captain = await client.callTool({ name: "capy_captains_create", arguments: { body: { requestId: "retry-1", projectId: "project-1", name: "Helper" } } });
    expect(captain.structuredContent).toEqual({ threadId: "jam_captain" });
    expect(captain.content).toEqual([{ type: "text", text: '{"threadId":"jam_captain"}' }]);
    const message = await client.callTool({ name: "capy_messages_send", arguments: { path: { threadId: "jam_captain" }, body: { text: "Start", clientKey: "send-1", model: { modelId: "model-1", modes: { fast: false } } } } });
    expect(message.structuredContent).toEqual({ messageId: "msg_1" });
    expect(requests).toEqual([
      { url: "https://api.capy.ai/api/v1/captains", body: { requestId: "retry-1", projectId: "project-1", name: "Helper" } },
      { url: "https://api.capy.ai/api/v1/threads/jam_captain/message", body: { text: "Start", clientKey: "send-1", model: { modelId: "model-1", modes: { fast: false } } } },
    ]);
  });

  it("creates, updates, and lists issues with nulls and pagination intact", async () => {
    const requests: { url: string; method: string | undefined; body: unknown }[] = [];
    const client = await connect(async (url, init) => {
      requests.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json(init?.method === "GET" ? { issues: [{ code: "CAP-1" }], nextCursor: "1:2" } : { code: "CAP-1" });
    });
    await client.callTool({ name: "capy_issues_create", arguments: { body: { projectId: "project-1", title: "Fix", assignees: [{ kind: "user", id: "user-1" }] } } });
    await client.callTool({ name: "capy_issues_update", arguments: { path: { code: "CAP-1" }, body: { dueAt: null, parent: null, labelIds: [] } } });
    const page = await client.callTool({ name: "capy_issues_list", arguments: { query: { stateIds: ["state-1", "state-2"], limit: 1, cursor: "1:1" } } });
    expect(page.structuredContent).toEqual({ issues: [{ code: "CAP-1" }], nextCursor: "1:2" });
    expect(requests).toEqual([
      { url: "https://api.capy.ai/api/v1/issues", method: "POST", body: { projectId: "project-1", title: "Fix", assignees: [{ kind: "user", id: "user-1" }] } },
      { url: "https://api.capy.ai/api/v1/issues/CAP-1", method: "PATCH", body: { dueAt: null, parent: null, labelIds: [] } },
      { url: "https://api.capy.ai/api/v1/issues?stateIds=state-1&stateIds=state-2&limit=1&cursor=1%3A1", method: "GET", body: undefined },
    ]);
  });

  it.each([
    ["capy_captains_create", { body: { projectId: "p", name: "missing request id" } }],
    ["capy_captains_create", { body: { requestId: "", projectId: "p", name: "empty request id" } }],
    ["capy_messages_send", { path: { threadId: "t" }, body: { text: "secret text", model: { modelId: "m", modes: { fast: "yes" } } } }],
    ["capy_issues_create", { body: { projectId: "p", title: "Issue", assignees: [{ kind: "robot", id: "u" }] } }],
    ["capy_issues_update", { path: { code: "CAP-1" }, body: { files: [{ fileId: "f" }] } }],
    ["capy_issues_list", { query: { limit: 0 } }],
    ["capy_issues_list", { query: { secret: "private" } }],
    ["capy_issues_list", { apiKey: "injected" }],
  ])("rejects invalid %s arguments before any upstream request", async (name, args) => {
    let calls = 0;
    const client = await connect(async () => { calls++; return Response.json({}); });
    const error = await client.callTool({ name, arguments: args }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: -32602 });
    expect(String(error)).not.toContain("secret text");
    expect(calls).toBe(0);
  });

  it.each(["capy_issues_list", "not_a_tool", "__proto__", "constructor"])('rejects unknown or disabled tool "%s" as a protocol error', async (name) => {
    let calls = 0;
    const client = await connect(async () => { calls++; return Response.json({}); }, "captains");
    await expect(client.callTool({ name, arguments: {} })).rejects.toMatchObject({ code: -32602 });
    expect(calls).toBe(0);
  });

  it.each([".", "..", "", "\ud800"])('rejects unsafe path "%s" as invalid parameters before fetch', async (threadId) => {
    let calls = 0;
    const client = await connect(async () => { calls++; return Response.json({}); });
    await expect(client.callTool({ name: "capy_threads_get", arguments: { path: { threadId } } })).rejects.toMatchObject({ code: -32602 });
    expect(calls).toBe(0);
  });

  it.each([null, false, 0, "hello", [1, 2]])("wraps non-object JSON %j for structured content", async (value) => {
    const client = await connect(async () => Response.json(value));
    const result = await client.callTool({ name: "capy_issues_list" });
    expect(result.structuredContent).toEqual({ result: value });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(value) }]);
  });

  it("returns a successful null result for the bodyless leave operation", async () => {
    const client = await connect(async () => new Response(null, { status: 200 }));
    const result = await client.callTool({ name: "capy_threads_leave", arguments: { path: { threadId: "jam_1" } } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ result: null });
    expect(result.content).toEqual([{ type: "text", text: "null" }]);
  });

  it("returns an explicit tool error for an empty JSON-operation success", async () => {
    const client = await connect(async () => new Response(null, { status: 200 }));
    const result = await client.callTool({ name: "capy_issues_list" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: { code: "invalid_json", status: 200 } });
  });

  it("returns sanitized upstream failures as tool errors, not protocol errors", async () => {
    const client = await connect(async () => Response.json({ _tag: "capy/RateLimited", retryAfterSeconds: 10, message: "server-secret-key private request" }, { status: 429 }));
    const result = await client.callTool({ name: "capy_issues_list" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: { code: "http_error", status: 429, tag: "capy/RateLimited", retryAfterSeconds: 10 } });
    expect(JSON.stringify(result)).not.toContain("server-secret-key");
    expect(JSON.stringify(result)).not.toContain("private request");
  });

  it("does not leak thrown fetch exceptions into MCP results", async () => {
    const client = await connect(async () => { throw new Error("server-secret-key private request"); });
    const result = await client.callTool({ name: "capy_issues_list" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: { code: "network_error" } });
    expect(JSON.stringify(result)).not.toContain("server-secret-key");
    expect(JSON.stringify(result)).not.toContain("private request");
  });

  it("isolates credentials and bodies between concurrent server instances", async () => {
    const requests: { key: string | null; body: unknown }[] = [];
    const clients = await Promise.all(["key-one", "key-two"].map(async (apiKey) => {
      const server = createCapyServer({ apiKey }, { fetch: async (_url, init) => {
        const key = new Headers(init?.headers).get("authorization");
        const body: unknown = JSON.parse(String(init?.body));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        requests.push({ key, body });
        return Response.json({ key });
      } });
      const client = new Client({ name: "isolation-test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      cleanups.push(async () => { await client.close(); await server.close(); });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return client;
    }));
    const results = await Promise.all(clients.map((client, index) => client.callTool({ name: "capy_issues_create", arguments: { body: { projectId: "p", title: `issue-${index}` } } })));
    expect(requests).toEqual(expect.arrayContaining([
      { key: "Bearer key-one", body: { projectId: "p", title: "issue-0" } },
      { key: "Bearer key-two", body: { projectId: "p", title: "issue-1" } },
    ]));
    expect(results.map((result) => result.structuredContent)).toEqual([{ key: "Bearer key-one" }, { key: "Bearer key-two" }]);
  });

  it("propagates MCP request cancellation to the upstream request", async () => {
    let signal: AbortSignal | null | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const client = await connect(async (_url, init) => { signal = init?.signal; started(); return new Promise<Response>(() => {}); });
    const controller = new AbortController();
    const result = client.callTool({ name: "capy_issues_list" }, { signal: controller.signal }).catch((error: unknown) => error);
    await ready;
    controller.abort();
    await result;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(signal?.aborted).toBe(true);
  });
});
