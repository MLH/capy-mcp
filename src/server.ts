import { ProtocolError, ProtocolErrorCode, Server } from "@modelcontextprotocol/server";
import { selectOperations } from "./catalog.js";
import { callCapy, CapyError, type ToolArguments } from "./client.js";
import { validators } from "./generated/validators.js";

export function createCapyServer(
  config: { apiKey: string; groups?: string },
  options?: { fetch?: typeof fetch; signal?: AbortSignal },
): Server {
  const operations = new Map(selectOperations(config.groups).map((operation) => [operation.name, operation]));
  const server = new Server({ name: "capy-mcp", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", () => ({
    tools: [...operations.values()].map(({ name, description, inputSchema, annotations }) => ({
      name, description, inputSchema: { ...inputSchema, type: "object" as const }, annotations,
    })),
  }));
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const operation = operations.get(request.params.name);
    if (!operation) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown or disabled tool");
    const args = request.params.arguments ?? {};
    const validate = validators[operation.name as keyof typeof validators];
    if (!validate(args)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid tool arguments");
    try {
      const value = await callCapy(operation, args as ToolArguments, {
        apiKey: config.apiKey,
        signal: options?.signal ? AbortSignal.any([ctx.mcpReq.signal, options.signal]) : ctx.mcpReq.signal,
        fetch: options?.fetch,
      });
      const structuredContent = value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : { result: value };
      return { structuredContent, content: [{ type: "text", text: JSON.stringify(value) }] };
    } catch (error) {
      if (error instanceof CapyError && error.code === "unsafe_path") {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid tool path");
      }
      const structuredContent = { error: (error instanceof CapyError ? error : new CapyError("network_error")).toJSON() };
      return { isError: true, structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
    }
  });
  return server;
}
