import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createCapyServer } from "./server.js";

async function main() {
  const apiKey = process.env.CAPY_API_KEY;
  if (!apiKey || !/^[\x21-\x7e]+$/.test(apiKey)) throw new Error("Invalid configuration");
  const server = createCapyServer({ apiKey, groups: process.env.CAPY_TOOL_GROUPS });
  const shutdown = () => {
    server.close().catch(() => {
      process.stderr.write("capy-mcp: shutdown failed\n");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
}

main().catch(() => {
  process.stderr.write("capy-mcp: invalid startup configuration\n");
  process.exitCode = 1;
});
