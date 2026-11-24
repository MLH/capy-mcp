import { isIP } from "node:net";
import * as client from "openid-client";
import type { HostedConfig } from "./config.js";
import { boundedBody } from "./http.js";
import { isAdmissionString, isOidcSubject, type Identity, type LoginTransaction } from "./store.js";

export const OIDC_CALLBACK_PATH = "/auth/callback";

const authorizationInputs = new Set([
  "client_id", "response_type", "redirect_uri", "response_mode", "scope", "state", "nonce",
  "code_challenge", "code_challenge_method", "request", "request_uri",
]);

function publicHttps(raw: unknown): URL {
  if (typeof raw !== "string" || raw.length > 2_048 || raw.includes("#")) throw new Error("Invalid endpoint");
  const url = new URL(raw);
  const hostname = url.hostname.replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password ||
      (raw !== url.href && raw !== url.origin) || !hostname.includes(".") ||
      isIP(hostname.replace(/^\[|\]$/g, "")) ||
      /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/.test(hostname)) {
    throw new Error("Invalid endpoint");
  }
  return url;
}

async function identityClient(config: HostedConfig, inbound: AbortSignal): Promise<client.Configuration> {
  const issuer = publicHttps(config.issuer);
  const discoveryUrl = issuer.href.replace(/\/$/, "") + "/.well-known/openid-configuration";
  const endpoints = new Set([`GET ${discoveryUrl}`]);
  const budget = AbortSignal.any([inbound, AbortSignal.timeout(12_000)]);
  const authenticate: client.ClientAuth = (server, metadata, body, headers) => {
    const methods = server.token_endpoint_auth_methods_supported;
    if (methods?.includes("client_secret_post")) {
      client.ClientSecretPost(config.clientSecret)(server, metadata, body, headers);
    } else if (!methods || methods.includes("client_secret_basic")) {
      client.ClientSecretBasic(config.clientSecret)(server, metadata, body, headers);
    } else {
      throw new Error("Unsupported client authentication");
    }
  };
  const verified = await client.discovery(issuer, config.clientId, { [client.clockTolerance]: 0 }, authenticate, {
    timeout: 5,
    execute: [client.enableNonRepudiationChecks],
    [client.customFetch]: async (url, { method, headers, body, signal }) => {
      if (!endpoints.has(`${method} ${url}`) || (body !== undefined && !(body instanceof URLSearchParams))) {
        throw new Error("Unexpected identity request");
      }
      const deadline = signal ? AbortSignal.any([budget, signal]) : budget;
      const response = await fetch(url, { method, body, headers, redirect: "manual", signal: deadline });
      if (response.status !== 200) {
        response.body?.cancel().catch(() => {});
        throw new Error("Identity request failed");
      }
      const bytes = await boundedBody(response, 262_144, deadline);
      return new Response(bytes, { headers: response.headers });
    },
  });
  const metadata = verified.serverMetadata();
  if (metadata.issuer !== config.issuer ||
      (metadata.code_challenge_methods_supported !== undefined && !metadata.code_challenge_methods_supported.includes("S256"))) {
    throw new Error("Unexpected identity metadata");
  }
  const authorization = publicHttps(metadata.authorization_endpoint);
  if (Array.from(authorization.searchParams.keys()).some((key) => authorizationInputs.has(key))) {
    throw new Error("Conflicting identity request parameters");
  }
  endpoints.add(`POST ${publicHttps(metadata.token_endpoint).href}`);
  endpoints.add(`GET ${publicHttps(metadata.jwks_uri).href}`);
  return verified;
}

export async function authorizationStart(config: HostedConfig, signal: AbortSignal) {
  const oidc = await identityClient(config, signal);
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const redirect = client.buildAuthorizationUrl(oidc, {
    response_type: "code",
    redirect_uri: config.publicOrigin + OIDC_CALLBACK_PATH,
    scope: "openid",
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
  });
  return { redirect, state, nonce, verifier };
}

export async function verifiedIdentity(
  config: HostedConfig, callback: URL, state: string, login: LoginTransaction, signal: AbortSignal,
): Promise<Identity> {
  const oidc = await identityClient(config, signal);
  const grant = await client.authorizationCodeGrant(oidc, callback, {
    expectedState: state, expectedNonce: login.nonce, pkceCodeVerifier: login.verifier,
  });
  const claims = grant.claims();
  if (!claims || claims.iss !== config.issuer || !isOidcSubject(claims.sub) ||
      (claims.azp !== undefined && claims.azp !== config.clientId) ||
      (Array.isArray(claims.aud) && claims.aud.length !== 1)) {
    throw new Error("Unexpected identity claims");
  }
  const claim = config.claim?.name;
  const value = claim && Object.hasOwn(claims, claim) ? claims[claim] : undefined;
  return { issuer: claims.iss, subject: claims.sub, admissionClaims: claim && isAdmissionString(value) ? { [claim]: value } : {} };
}
