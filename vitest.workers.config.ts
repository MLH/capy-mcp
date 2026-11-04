import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    remoteBindings: false,
    miniflare: { bindings: { CAPY_API_KEY: "test-upstream-key", MCP_AUTH_TOKEN: "test-mcp-token" } },
  })],
  test: { include: ["tests/worker.test.ts"] },
});
