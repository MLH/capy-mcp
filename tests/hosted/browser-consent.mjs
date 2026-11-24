import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { convertV4MiniflareOptions, Miniflare, Response as MfResponse } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";
import { browserIssuer } from "./fixtures/browser-issuer.mjs";

const callbacks = new Map();
const receiver = (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/callback") {
    const allowed = Boolean(url.searchParams.get("code")) && !url.searchParams.has("error");
    const denied = !url.searchParams.has("code") && url.searchParams.get("error") === "access_denied";
    const state = url.searchParams.get("state");
    if (callbacks.has(state) && (allowed || denied)) {
      callbacks.set(state, {
        host: req.headers.host, decision: allowed ? "allow" : "deny", code: url.searchParams.get("code"),
        private: !req.headers.referer && !req.headers.cookie,
      });
    }
  }
  res.end("Fixture MCP client");
};
const client = createServer(receiver);
const ipv6Client = createServer(receiver);
async function listen(server, host = "127.0.0.1") {
  server.listen(0, host);
  await once(server, "listening");
  return server.address().port;
}
const clientPort = await listen(client);
const ipv6Port = await listen(ipv6Client, "::1");
const reservation = createServer();
const port = await listen(reservation);
await new Promise(resolve => reservation.close(resolve));
const origin = "https://127.0.0.1:" + port;
const redirect = "http://localhost:" + clientPort + "/callback";
const ipv6Redirect = "http://[::1]:" + ipv6Port + "/callback";
const profile = await mkdtemp(join(tmpdir(), "consent-fixture-"));
const opaque = () => randomBytes(32).toString("base64url");
const fixtureKey = opaque();
const { server: issuerServer, issuer, clientId, clientSecret, fetch: issuerFetch, counts } = await browserIssuer(profile, listen, origin);
const metadata = "https://client-metadata.example.invalid/client.json";
let followed = 0;
let capyCalls = 0;
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, scriptPath: "dist/worker/worker.js", port, host: "127.0.0.1", https: true,
  compatibilityDate: "2026-11-23", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  d1Databases: ["DB"], kvNamespaces: ["OAUTH_KV"], ratelimits: Object.fromEntries(["AUTH_RATE_LIMITER", "ACCOUNT_RATE_LIMITER"].map(
    (k, i) => [k, { namespace_id: String(i + 1), simple: { limit: 100, period: 60 } }])),
  bindings: { PUBLIC_ORIGIN: origin, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret,
    OIDC_ALLOWED_SUBJECTS: '["demo-member"]', OIDC_ADMISSION_CLAIM: "hd", OIDC_ALLOWED_CLAIM_VALUES: '["team.example.invalid"]',
    CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"), CREDENTIAL_ENCRYPTION_KEY_ID: "v1" },
  outboundService(req) {
    if (req.url === metadata) return MfResponse.redirect("https://other.example.invalid/document");
    if (req.url === "https://other.example.invalid/document") {
      followed++;
      return MfResponse.json({ client_id: metadata, client_name: "Redirected document", redirect_uris: [redirect], token_endpoint_auth_method: "none" });
    }
    if (req.url === "https://api.capy.ai/api/v1/projects" && req.method === "GET" &&
        req.headers.get("Authorization") === "Bearer " + fixtureKey) {
      capyCalls++;
      return MfResponse.json({ projects: [] });
    }
    return issuerFetch(req);
  },
}));
let chrome;
try {
  await mf.ready;
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) {
    for (const sql of unstable_splitSqlQuery(await readFile("migrations/" + file, "utf8"))) await db.prepare(sql).run();
  }
  const registration = await mf.dispatchFetch(origin + "/register", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Example MCP client", redirect_uris: [redirect, ipv6Redirect], token_endpoint_auth_method: "none" }) });
  assert.equal(registration.status, 201);
  const { client_id } = await registration.json();
  const resource = origin + "/mcp";
  const authorization = (id, redirectUri) => {
    const state = opaque(), verifier = opaque();
    const url = origin + "/authorize?" + new URLSearchParams({ client_id: id, resource, response_type: "code",
      scope: "capy:read capy:write offline_access", state, redirect_uri: redirectUri,
      code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
    return { url, state, verifier, redirectUri };
  };
  const cimd = await mf.dispatchFetch(authorization(metadata, redirect).url, { redirect: "manual" });
  assert.equal(cimd.status, 503);
  assert.equal(followed, 0, "CIMD must not follow redirected metadata");
  chrome = spawn(process.env.CHROMIUM_BIN || "chromium", ["--headless", "--no-sandbox", "--disable-dev-shm-usage",
    "--ignore-certificate-errors", "--disable-background-networking", "--no-first-run", "--no-proxy-server",
    "--host-resolver-rules=MAP id.example.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1], EXCLUDE ::1",
    "--remote-debugging-pipe", "--user-data-dir=" + join(profile, "chromium")],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const commands = new Map();
  let sequence = 0, pending = "";
  chrome.stdio[4].setEncoding("utf8");
  chrome.stdio[4].on("data", chunk => {
    const messages = (pending + chunk).split("\0");
    pending = messages.pop();
    for (const message of messages) {
      const result = JSON.parse(message);
      if (result.id) commands.get(result.id)?.(result);
    }
  });
  function cdp(method, params, sessionId) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser timed out: " + method)), 5000);
      commands.set(id, result => {
        commands.delete(id); clearTimeout(timer);
        if (result.error) reject(new Error("Browser rejected " + method)); else resolve(result.result);
      });
      chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });
  }
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  const tab = (method, params) => cdp(method, params, sessionId);
  await tab("Emulation.setDeviceMetricsOverride", { width: 940, height: 850, deviceScaleFactor: 1, mobile: false });
  async function evaluate(expression) {
    return (await tab("Runtime.evaluate", { expression, returnByValue: true })).result?.value;
  }
  async function until(check, failure) {
    for (let i = 0; i < 80; i++) {
      if (await check()) return;
      await delay(50);
    }
    assert.fail(failure);
  }
  async function rendered(text) {
    await until(() => evaluate(`document.body?.innerText.includes(${JSON.stringify(text)})`), "Page did not render: " + text);
  }
  async function navigate(url) {
    const result = await tab("Page.navigate", { url });
    assert.ok(!result.errorText, "Browser navigation failed: " + result.errorText);
  }
  async function click(selector) {
    const clicked = await evaluate(`(() => { const button = document.querySelector(${JSON.stringify(selector)}); if (!button) return false; button.click(); return true; })()`);
    assert.ok(clicked, "Control not rendered: " + selector);
  }
  async function capture(name) {
    const screenshotDir = process.env.HOSTED_SCREENSHOT_DIR;
    if (!screenshotDir) return;
    assert.ok(await evaluate(`[...document.querySelectorAll('input[type=password]')].every(input => input.value === '')`), "Never capture a populated key input");
    const destination = name === "04-consent" ? await evaluate(`(() => {
      const code = document.querySelector("main > p > code");
      const original = code.textContent;
      code.textContent = "[callback URL redacted]";
      return original;
    })()`) : null;
    try {
      assert.equal(await evaluate(`/(?:[?&](?:code|state|token)=|Bearer |https?:\\/\\/)/i.test(document.body.innerText)`), false,
        "Do not capture callback URLs or credentials in visible content");
      const height = Math.min(850, await evaluate("document.querySelector('main')?.getBoundingClientRect().bottom ?? 38") + 32);
      const { data } = await tab("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 940, height, scale: 1 } });
      await mkdir(screenshotDir, { recursive: true });
      await writeFile(join(screenshotDir, name + ".png"), Buffer.from(data, "base64"));
    } finally {
      if (destination) await evaluate(`document.querySelector("main > p > code").textContent = ${JSON.stringify(destination)}`);
    }
  }
  async function callback(flow, decision) {
    await until(() => callbacks.get(flow.state) !== undefined, "Registered callback did not arrive: " + new URL(flow.redirectUri).hostname + " " + decision);
    const result = callbacks.get(flow.state);
    assert.equal(result.host, new URL(flow.redirectUri).host);
    assert.equal(result.decision, decision);
    assert.equal(result.private, true, "Client callback received referrer or cookies");
    callbacks.delete(flow.state);
    return result.code;
  }

  await navigate(origin + "/account");
  await rendered("Sign in to Capy MCP");
  await capture("01-sign-in");
  await click('a[href="/auth/login"]');
  await rendered("Fixture identity provider");
  await click('button[formaction="/rejected"]');
  await rendered("Sign-in not allowed.");
  await capture("02-sign-in-error");
  assert.equal(await db.prepare("SELECT count(*) AS total FROM accounts").first("total"), 0);

  const onboard = authorization(client_id, redirect);
  callbacks.set(onboard.state, undefined);
  await navigate(onboard.url);
  await rendered("Fixture identity provider");
  await click('button[formaction="/approved"]');
  await rendered("Connect your Capy key");
  assert.ok(counts().issued === 2 && counts().verifiedKeys >= 2, "Both signed identity tokens were exchanged and JWKS fetched");
  await capture("03-connect-key");
  assert.ok(await evaluate(`(() => { const input = document.querySelector('input[name="key"]'); if (!input) return false; input.focus(); return true; })()`));
  await tab("Input.insertText", { text: fixtureKey });
  await click('form[action^="/account/key?"] button');
  await rendered("Authorize MCP client");
  assert.equal(capyCalls, 1);
  assert.equal(await evaluate(`document.querySelector("main > p > code")?.textContent === ${JSON.stringify(redirect)}`), true);
  assert.ok(await evaluate("document.querySelector('input[name=write]')?.checked === false"), "Write must be opt-in");
  await capture("04-consent");
  await click('button[value="allow"]');
  const code = await callback(onboard, "allow");
  assert.ok(Boolean(code));
  const exchange = await mf.dispatchFetch(origin + "/token", { method: "POST", body: new URLSearchParams({
    grant_type: "authorization_code", client_id, resource, code, code_verifier: onboard.verifier, redirect_uri: redirect,
  }) });
  assert.equal(exchange.status, 200);
  const tokens = await exchange.json();
  assert.ok(Boolean(tokens.access_token) && Boolean(tokens.refresh_token));
  assert.equal(tokens.scope, "capy:read offline_access");
  const call = () => mf.dispatchFetch(resource, { method: "POST", headers: { Authorization: "Bearer " + tokens.access_token,
    Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "capy_projects_list", arguments: {} } }) });
  const read = await call();
  assert.equal(read.status, 200);
  assert.equal((await read.json()).result?.isError, undefined);
  assert.equal(capyCalls, 2);

  await navigate(origin + "/account");
  await rendered("Example MCP client");
  await capture("05-account");
  await click('a[href^="/account?confirm=revoke&"]');
  await rendered("Other clients, the key, and this browser session are unchanged.");
  await capture("06-revoke");
  await click('form[action$="/revoke"] button');
  await rendered("No authorized MCP clients");
  await capture("07-revoked");
  assert.equal((await call()).status, 401);
  assert.equal((await mf.dispatchFetch(origin + "/token", { method: "POST", body: new URLSearchParams({
    grant_type: "refresh_token", client_id, resource, refresh_token: tokens.refresh_token,
  }) })).status, 400);
  assert.equal(capyCalls, 2, "Revoked tokens must not call fake Capy");

  for (const uri of [redirect, ipv6Redirect]) {
    for (const decision of ["allow", "deny"]) {
      const flow = authorization(client_id, uri);
      callbacks.set(flow.state, undefined);
      await navigate(flow.url);
      await rendered("Authorize MCP client");
      await click(`button[value="${decision}"]`);
      await callback(flow, decision);
    }
  }
  await navigate(origin + "/account?confirm=disconnect");
  await rendered("Disconnect all clients");
  await click('form[action="/account/disconnect"] button');
  await rendered("No authorized MCP clients");
  assert.equal(await db.prepare("SELECT authorization_epoch FROM accounts").first("authorization_epoch"), 1);
  console.log("PASS: signed cross-site OIDC admission and denial, Capy onboarding, consent and OAuth PKCE exchange, authenticated MCP call, closed revocation, guarded disconnect, and private IPv4/IPv6 loopback callbacks.");
} finally {
  if (chrome && chrome.exitCode === null) { const closed = once(chrome, "exit"); chrome.kill(); await closed; }
  await mf.dispose();
  for (const server of [client, ipv6Client, issuerServer]) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
