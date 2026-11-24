import { env } from "cloudflare:workers";
import type { EncryptionConfig } from "../../src/hosted/crypto.js";

export function hostedEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    PUBLIC_ORIGIN: "https://mcp.example.invalid",
    OIDC_ISSUER: "https://id.example.invalid/tenant",
    OIDC_CLIENT_ID: "test-client",
    OIDC_CLIENT_SECRET: "test-client-secret",
    OIDC_ALLOWED_SUBJECTS: "",
    OIDC_ADMISSION_CLAIM: "hd",
    OIDC_ALLOWED_CLAIM_VALUES: '["team.example.invalid"]',
    CREDENTIAL_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    CREDENTIAL_ENCRYPTION_KEY_ID: "v1",
    ...overrides,
  };
}

export function fakeEncryption(fill = 7): EncryptionConfig {
  return { keyId: "v1", key: new Uint8Array(32).fill(fill) };
}
