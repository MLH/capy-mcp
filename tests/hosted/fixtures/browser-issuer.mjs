import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import { Response } from "miniflare";
import { signedIdToken, signingJwk, signingKey } from "./oidc-signing.ts";

export async function browserIssuer(profile, listen, origin) {
  const keyPath = join(profile, "issuer-key.pem"), certPath = join(profile, "issuer-cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=id.example.invalid", "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
  const keys = await signingKey();
  const jwk = await signingJwk(keys.publicKey);
  const redirect = origin + "/auth/callback";
  const clientId = "browser-fixture";
  const clientSecret = randomBytes(32).toString("base64url");
  const codes = new Map();
  let pending;
  let issuer;
  let issued = 0;
  let verifiedKeys = 0;
  const server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (req, res) => {
    const url = new URL(req.url, issuer);
    if (req.method === "GET" && url.pathname === "/authorize") {
      const p = url.searchParams;
      if (p.get("client_id") === clientId && p.get("redirect_uri") === redirect &&
          p.get("response_type") === "code" && p.get("scope") === "openid" && p.get("code_challenge_method") === "S256" &&
          ["state", "nonce", "code_challenge"].every(name => /^[\w-]{43}$/.test(p.get(name) ?? ""))) {
        pending = { challenge: p.get("code_challenge"), nonce: p.get("nonce"), state: p.get("state") };
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
        res.end(`<!doctype html><html lang="en"><title>Fixture identity provider</title>
          <main><h1>Fixture identity provider</h1><form method="post">
          <button formaction="/rejected">Use non-admitted identity</button>
          <button formaction="/approved">Use admitted identity</button>
          </form></main></html>`);
        return;
      }
    }
    if (pending && req.method === "POST" && ["/approved", "/rejected"].includes(url.pathname)) {
      const code = randomBytes(32).toString("base64url");
      const { state, ...flow } = pending;
      pending = undefined;
      codes.set(code, { ...flow, member: url.pathname === "/approved" });
      const callback = new URL(redirect);
      callback.search = new URLSearchParams({ code, state });
      res.writeHead(303, { Location: callback.href, "Referrer-Policy": "no-referrer" });
      res.end();
      return;
    }
    res.writeHead(400).end("Invalid fixture request");
  });
  issuer = "https://id.example.invalid:" + await listen(server);
  return {
    server, issuer, clientId, clientSecret,
    counts: () => ({ issued, verifiedKeys }),
    async fetch(req) {
      if (req.method === "GET" && req.url === issuer + "/.well-known/openid-configuration") {
        return Response.json({ issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token",
          jwks_uri: issuer + "/jwks", code_challenge_methods_supported: ["S256"],
          id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_post"],
          response_types_supported: ["code"], subject_types_supported: ["public"] });
      }
      if (req.method === "GET" && req.url === issuer + "/jwks") {
        verifiedKeys++;
        return Response.json({ keys: [jwk] });
      }
      if (req.method === "POST" && req.url === issuer + "/token") {
        const form = new URLSearchParams(await req.text());
        const code = form.get("code");
        const flow = codes.get(code);
        codes.delete(code);
        const verifier = form.get("code_verifier");
        if (!flow || !verifier || form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret ||
            form.get("redirect_uri") !== redirect || form.get("grant_type") !== "authorization_code" ||
            createHash("sha256").update(verifier).digest("base64url") !== flow.challenge) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const now = Math.floor(Date.now() / 1000);
        issued++;
        return Response.json({ id_token: await signedIdToken(keys.privateKey, {
          iss: issuer, aud: clientId, sub: flow.member ? "demo-member" : "demo-visitor",
          nonce: flow.nonce, iat: now, exp: now + 300, hd: "team.example.invalid",
        }), token_type: "Bearer", access_token: randomBytes(32).toString("base64url") });
      }
      throw new Error("Unexpected outbound issuer request");
    },
  };
}
