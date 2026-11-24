import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    remoteBindings: false,
    miniflare: { bindings: {
      OIDC_CLIENT_ID: "test-client", OIDC_CLIENT_SECRET: "test-client-secret", OIDC_ISSUER: "https://accounts.google.com",
      OIDC_ADMISSION_CLAIM: "hd", OIDC_ALLOWED_CLAIM_VALUES: '["team.example.invalid"]',
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    } },
  })],
  test: {
    include: ["tests/worker.test.ts", "tests/hosted/**/*.test.ts"],
    provide: { hostedMigrations: await readD1Migrations("./migrations") },
  },
});
