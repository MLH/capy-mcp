import { describe, expect, it } from "vitest";
import { admit, parseHostedConfig } from "../../src/hosted/config.js";
import { hostedEnv } from "./fixtures.js";

const issuer = "https://id.example.invalid/tenant";
const identity = { issuer, subject: "member", admissionClaims: { hd: "team.example.invalid" } };

describe("hosted deployment configuration", () => {
  it("validates the configured public origin, issuer, encryption and existing settings", () => {
    const config = parseHostedConfig(hostedEnv({
      CAPY_TOOL_GROUPS: "issues",
      MCP_ALLOWED_ORIGINS: "https://client.example.invalid,http://localhost:8080",
    }));
    expect(config).toMatchObject({
      publicOrigin: "https://mcp.example.invalid",
      issuer,
      clientId: "test-client",
      groups: "issues",
      allowedOrigins: ["https://client.example.invalid", "http://localhost:8080"],
      encryption: { keyId: "v1", key: new Uint8Array(32).fill(7) },
    });
  });

  it("rejects missing admission even when every other setting is valid", () => {
    expect(() => parseHostedConfig(hostedEnv({
      OIDC_ADMISSION_CLAIM: "",
      OIDC_ALLOWED_CLAIM_VALUES: "",
    }))).toThrow("Invalid hosted configuration");
  });

  it.each([
    { OIDC_ALLOWED_SUBJECTS: "[]" },
    { OIDC_ALLOWED_CLAIM_VALUES: "[]" },
  ])("denies everyone if a configured allowlist is empty: %j", (overrides) => {
    expect(admit(identity, parseHostedConfig(hostedEnv(overrides)))).toBe(false);
  });

  it("requires both policies to match and always checks the issuer", () => {
    const config = parseHostedConfig(hostedEnv({ OIDC_ALLOWED_SUBJECTS: '["member"]' }));
    expect(admit(identity, config)).toBe(true);
    expect(admit({ ...identity, subject: "other" }, config)).toBe(false);
    expect(admit({ ...identity, admissionClaims: { hd: "other.example.invalid" } }, config)).toBe(false);
    expect(admit({ ...identity, issuer: "https://other.example.invalid" }, config)).toBe(false);
  });

  it("allows an exact subject match when only subjects are configured", () => {
    const config = parseHostedConfig(hostedEnv({
      OIDC_ALLOWED_SUBJECTS: '["member"]',
      OIDC_ADMISSION_CLAIM: "",
      OIDC_ALLOWED_CLAIM_VALUES: "",
    }));
    expect(admit({ ...identity, admissionClaims: {} }, config)).toBe(true);
    expect(admit({ ...identity, subject: "Member" }, config)).toBe(false);
  });

  it.each([undefined, ["team.example.invalid"], true, 17, "TEAM.example.invalid", "team.example.invalid "].map((hd) => ({ hd })))(
    "rejects a missing, wrongly typed or inexact signed claim: %j",
    ({ hd }) => {
      const config = parseHostedConfig(hostedEnv());
      expect(admit(identity, config)).toBe(true);
      expect(admit({ ...identity, admissionClaims: { hd } }, config)).toBe(false);
    },
  );

  it("does not accept an inherited admission claim", () => {
    const config = parseHostedConfig(hostedEnv());
    const inherited: Record<string, unknown> = Object.create(identity.admissionClaims);
    expect(admit({ ...identity, admissionClaims: inherited }, config)).toBe(false);
  });

  describe.each([
    ["PUBLIC_ORIGIN", ["http://mcp.example.invalid", "https://mcp.example.invalid/path", "https://mcp.example.invalid/", "https://user@mcp.example.invalid", "not a URL"]],
    ["OIDC_ISSUER", ["http://id.example.invalid", "https://id.example.invalid/path?", "https://id.example.invalid/path#fragment", "https://user:pass@id.example.invalid", "https://id.example.invalid\\tenant"]],
    ["OIDC_CLIENT_ID", ["", "   "]],
    ["OIDC_CLIENT_SECRET", ["", "   "]],
    ["OIDC_ALLOWED_SUBJECTS", ["subject", '[1]', '[""]', JSON.stringify(["a".repeat(256)])]],
    ["OIDC_ADMISSION_CLAIM", ["", " hd ", "c".repeat(257)]],
    ["OIDC_ALLOWED_CLAIM_VALUES", ["", '["valid", null]', '{"team":true}', JSON.stringify(["a".repeat(257)])]],
    ["CREDENTIAL_ENCRYPTION_KEY", ["", "not-base64", btoa("x".repeat(31)), btoa("x".repeat(33)), btoa("x".repeat(32)).replace(/=$/, ""), btoa("x".repeat(32)).replace(/g=$/, "h=")]],
    ["CREDENTIAL_ENCRYPTION_KEY_ID", ["", "v1 key"]],
    ["CAPY_TOOL_GROUPS", ["missing-group"]],
    ["MCP_ALLOWED_ORIGINS", ["*", "https://client.example.invalid/", "https://client.example.invalid,"]],
  ] as const)("%s validation", (binding, values) => {
    for (const [index, value] of values.entries()) {
      it(`rejects invalid value #${index + 1} without echoing it`, () => {
        expect(() => parseHostedConfig(hostedEnv({ [binding]: value }))).toThrow(/^Invalid hosted configuration$/);
      });
    }
  });

  it.each(["AUTH_RATE_LIMITER", "ACCOUNT_RATE_LIMITER", "DB", "OAUTH_KV"] as const)(
    "fails closed when %s is unavailable",
    (binding) => {
      const env = hostedEnv();
      Reflect.deleteProperty(env, binding);
      expect(() => parseHostedConfig(env)).toThrow(/^Invalid hosted configuration$/);
    },
  );
});
