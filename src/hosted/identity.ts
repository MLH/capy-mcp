import * as oidc from "openid-client";
import type { HostedConfig } from "./config.js";
import { isAdmissionString, isOidcSubject, type Identity } from "./store.js";
import { readBoundedBody, withinDeadline } from "./http.js";

export const OIDC_CALLBACK_PATH = "/auth/callback";
const requestSeconds = 5;
const flowMillis = 12_000;
const maxBodyBytes = 262_144;

function trustedEndpoint(value: unknown, issuer: URL, exception?: string): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error("Invalid identity endpoint");
  const url = new URL(value);
  if (url.href !== value || url.protocol !== "https:" || url.username || url.password ||
      /[?#]/.test(value) || (url.origin !== issuer.origin && url.href !== exception)) {
    throw new Error("Invalid identity endpoint");
  }
  return url.href;
}

async function discover(config: HostedConfig, requestSignal: AbortSignal) {
  const issuer = new URL(config.issuer);
  const discovery = new URL(issuer);
  discovery.pathname = `${issuer.pathname.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const deadline = AbortSignal.any([requestSignal, AbortSignal.timeout(flowMillis)]);
  const allowed = new Map([[discovery.href, "GET"]]);
  const clientAuth: oidc.ClientAuth = (server, client, body, headers) => {
    const supported = server.token_endpoint_auth_methods_supported;
    if (supported?.includes("client_secret_post")) return oidc.ClientSecretPost(config.clientSecret)(server, client, body, headers);
    if (!supported || supported.includes("client_secret_basic")) return oidc.ClientSecretBasic(config.clientSecret)(server, client, body, headers);
    throw new Error("Unsupported identity client authentication");
  };
  const client = await oidc.discovery(issuer, config.clientId, { [oidc.clockTolerance]: 0 }, clientAuth, {
    execute: [oidc.enableNonRepudiationChecks],
    timeout: requestSeconds,
    [oidc.customFetch]: async (url, options) => {
      if (allowed.get(url) !== options.method) throw new Error("Invalid identity endpoint");
      if (options.body !== undefined && !(options.body instanceof URLSearchParams)) throw new Error("Invalid identity request");
      const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
      const response = await withinDeadline(fetch(url, {
        method: options.method, headers: options.headers, body: options.body, redirect: "manual", signal,
      }), signal);
      if (response.status !== 200) {
        if (response.body) await withinDeadline(response.body.cancel(), signal).catch(() => {});
        throw new Error("Identity endpoint unavailable");
      }
      const body = await readBoundedBody(response, maxBodyBytes, signal);
      return new Response(body, { status: response.status, headers: response.headers });
    },
  });
  const metadata = client.serverMetadata();
  if (metadata.issuer !== config.issuer ||
      (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes("S256"))) {
    throw new Error("Invalid identity metadata");
  }
  const google = config.issuer === "https://accounts.google.com";
  trustedEndpoint(metadata.authorization_endpoint, issuer);
  const token = trustedEndpoint(metadata.token_endpoint, issuer, google ? "https://oauth2.googleapis.com/token" : undefined);
  const jwks = trustedEndpoint(metadata.jwks_uri, issuer, google ? "https://www.googleapis.com/oauth2/v3/certs" : undefined);
  allowed.set(token, "POST");
  allowed.set(jwks, "GET");
  return client;
}

export async function startIdentityLogin(config: HostedConfig, signal: AbortSignal) {
  const client = await discover(config, signal);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const location = oidc.buildAuthorizationUrl(client, {
    redirect_uri: config.publicOrigin + OIDC_CALLBACK_PATH,
    scope: "openid",
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
  });
  return { state, nonce, verifier, location };
}

export async function finishIdentityLogin(
  config: HostedConfig, callback: URL, signal: AbortSignal, state: string, nonce: string, verifier: string,
): Promise<Identity> {
  const client = await discover(config, signal);
  const tokens = await oidc.authorizationCodeGrant(client, callback, {
    expectedState: state, expectedNonce: nonce, pkceCodeVerifier: verifier,
  });
  const claims = tokens.claims();
  if (!claims || !isOidcSubject(claims.sub) ||
      (claims.azp !== undefined && claims.azp !== config.clientId) ||
      (Array.isArray(claims.aud) && claims.aud.length !== 1)) {
    throw new Error("Invalid identity claims");
  }
  const name = config.claim?.name;
  const value = name && Object.hasOwn(claims, name) ? claims[name] : undefined;
  return {
    issuer: claims.iss, subject: claims.sub,
    admissionClaims: name && isAdmissionString(value) ? { [name]: value } : {},
  };
}
