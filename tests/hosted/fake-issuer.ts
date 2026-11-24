import { vi } from "vitest";
import { hostedEnv } from "./fixtures.js";
import { signedIdToken, signingJwk } from "./fixtures/oidc-signing.js";
export { signingKey } from "./fixtures/oidc-signing.js";

export const browserOrigin = "https://mcp.example.invalid";
export const googleIssuer = "https://accounts.google.com";
export const entraIssuer = "https://login.microsoftonline.com/00000000-0000-4000-8000-000000000002/v2.0";

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const encoder = new TextEncoder();

export async function fakeIssuer(keys: CryptoKeyPair, options: {
  issuer?: string;
  claimName?: string;
  claimValue?: string;
  claims?: Record<string, unknown>;
  endpoints?: { authorization: string; token: string; jwks: string };
  metadata?: Record<string, unknown>;
  discoveryResponse?: () => Response;
  tokenResponse?: () => Response;
  corruptSignature?: boolean;
} = {}) {
  const issuer = options.issuer ?? googleIssuer;
  const claimName = options.claimName ?? "hd";
  const claimValue = options.claimValue ?? "team.example.invalid";
  const env = hostedEnv({
    OIDC_ISSUER: issuer, OIDC_ADMISSION_CLAIM: claimName,
    OIDC_ALLOWED_CLAIM_VALUES: JSON.stringify([claimValue]),
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  });
  const discovery = `${issuer}/.well-known/openid-configuration`;
  const tenant = issuer.replace(/\/v2\.0$/, "");
  const authorization = options.endpoints?.authorization ??
    (issuer === googleIssuer ? `${issuer}/o/oauth2/v2/auth` : `${tenant}/oauth2/v2.0/authorize`);
  const token = options.endpoints?.token ??
    (issuer === googleIssuer ? "https://oauth2.googleapis.com/token" : `${tenant}/oauth2/v2.0/token`);
  const jwks = options.endpoints?.jwks ??
    (issuer === googleIssuer ? "https://www.googleapis.com/oauth2/v3/certs" : `${tenant}/discovery/v2.0/keys`);
  const jwk = await signingJwk(keys.publicKey);
  const requests: string[] = [];
  const flows = new Map<string, { nonce: string; challenge: string; redirect: string }>();
  let nextCode = 0;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    requests.push(input);
    if (init.redirect !== "manual") throw new Error("Expected manual OIDC redirects");
    if (input === discovery && init.method === "GET") {
      return options.discoveryResponse?.() ?? Response.json({
        issuer, authorization_endpoint: authorization, token_endpoint: token, jwks_uri: jwks,
        ...(issuer === googleIssuer ? { code_challenge_methods_supported: ["S256"] } : {}),
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        response_types_supported: ["code"], subject_types_supported: ["public"],
        ...options.metadata,
      });
    }
    if (input === jwks && init.method === "GET") return Response.json({ keys: [jwk] });
    if (input !== token || init.method !== "POST" || !(init.body instanceof URLSearchParams)) {
      throw new Error("Unexpected outbound OIDC request");
    }
    if (options.tokenResponse) return options.tokenResponse();
    const params = init.body;
    const flow = flows.get(params.get("code") ?? "");
    const headers = new Headers(init.headers);
    const authenticated = (params.get("client_id") === env.OIDC_CLIENT_ID &&
      params.get("client_secret") === env.OIDC_CLIENT_SECRET) ||
      headers.get("authorization") === `Basic ${btoa(`${env.OIDC_CLIENT_ID}:${env.OIDC_CLIENT_SECRET}`)}`;
    const verifier = params.get("code_verifier") ?? "";
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
    if (!flow || !authenticated || !verifier || challenge !== flow.challenge ||
        params.get("redirect_uri") !== flow.redirect || params.get("grant_type") !== "authorization_code") {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: issuer, aud: env.OIDC_CLIENT_ID, sub: "member-1", iat: now, exp: now + 300, nonce: flow.nonce,
      [claimName]: claimValue, email: "same@example.invalid", ...options.claims,
    };
    return Response.json({
      id_token: await signedIdToken(keys.privateKey, claims, options.corruptSignature), token_type: "Bearer",
      access_token: "fixture-access-token", refresh_token: "fixture-refresh-token",
    });
  });

  return {
    env, requests, authorization, token, jwks,
    callback(start: Response) {
      const url = new URL(start.headers.get("Location") ?? "");
      const code = `fixture-code-${++nextCode}`;
      const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
      flows.set(code, {
        nonce: url.searchParams.get("nonce") ?? "", challenge: url.searchParams.get("code_challenge") ?? "",
        redirect: callback.href,
      });
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", url.searchParams.get("state") ?? "");
      return callback;
    },
  };
}
