import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { convertV4MiniflareOptions, Miniflare, Response as MfResponse } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";

const callbacks = [];
const disclosures = [];
const receiver = (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/callback") {
    const allowed = Boolean(url.searchParams.get("code")) && !url.searchParams.has("error");
    const denied = !url.searchParams.has("code") && url.searchParams.get("error") === "access_denied";
    if (url.searchParams.get("state") === "fixture" && (allowed || denied)) {
      callbacks.push(req.headers.host + "/" + (allowed ? "allow" : "access_denied"));
    }
    if (req.headers.referer || req.headers.cookie) disclosures.push("Unexpected callback referrer or cookie");
  }
  res.end("Client callback");
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
const issuer = "https://id.example.invalid";
const profile = await mkdtemp(join(tmpdir(), "consent-fixture-"));
const metadata = "https://client-metadata.example.invalid/client.json";
let followed = 0;
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, scriptPath: "dist/worker/worker.js", port, host: "127.0.0.1", https: true,
  compatibilityDate: "2026-11-23", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  d1Databases: ["DB"], kvNamespaces: ["OAUTH_KV"], ratelimits: Object.fromEntries(["AUTH_RATE_LIMITER", "ACCOUNT_RATE_LIMITER"].map(
    (k, i) => [k, { namespace_id: String(i + 1), simple: { limit: 100, period: 60 } }])),
  bindings: { PUBLIC_ORIGIN: origin, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "fixture", OIDC_CLIENT_SECRET: "fixture",
    OIDC_ALLOWED_SUBJECTS: '["member"]', CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), CREDENTIAL_ENCRYPTION_KEY_ID: "v1" },
  outboundService(req) {
    if (req.url === metadata) return MfResponse.redirect("https://other.example.invalid/document");
    if (req.url === "https://other.example.invalid/document") {
      followed++;
      return MfResponse.json({ client_id: metadata, client_name: "Redirected document", redirect_uris: [redirect], token_endpoint_auth_method: "none" });
    }
    throw new Error("Unexpected outbound fixture request");
  },
}));
let chrome;
const failures = [];
const navigations = [];
try {
  await mf.ready;
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) {
    for (const sql of unstable_splitSqlQuery(await readFile("migrations/" + file, "utf8"))) await db.prepare(sql).run();
  }
  const account = randomUUID();
  const opaque = () => randomBytes(32).toString("base64url");
  const digest = v => createHash("sha256").update(v).digest("hex");
  const session = opaque(), csrf = opaque();
  await db.prepare("INSERT INTO accounts VALUES (?, ?, 'member', '{}', 1, 0)").bind(account, issuer).run();
  await db.prepare("INSERT INTO credentials VALUES (?, 'v1', ?, ?, 1)").bind(account, "A".repeat(16), "A".repeat(24)).run();
  await db.prepare("INSERT INTO browser_sessions VALUES (?, ?, ?, ?)").bind(digest(session), account, digest(csrf), Date.now() + 300_000).run();
  const registration = await mf.dispatchFetch(origin + "/register", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Browser test", redirect_uris: [redirect, ipv6Redirect], token_endpoint_auth_method: "none" }) });
  assert.equal(registration.status, 201);
  const { client_id } = await registration.json();
  const authorize = (id, redirectUri = redirect) => origin + "/authorize?" + new URLSearchParams({ client_id: id, resource: origin + "/mcp", response_type: "code",
    scope: "capy:read", state: "fixture", redirect_uri: redirectUri, code_challenge_method: "S256", code_challenge: opaque() });
  const cimd = await mf.dispatchFetch(authorize(metadata), { headers: { Cookie: "__Host-capy-session=" + session + "; __Host-capy-csrf=" + csrf } });
  if (cimd.status === 200 || followed !== 0) failures.push("CIMD followed or accepted cross-origin metadata");
  chrome = spawn(process.env.CHROMIUM_BIN || "chromium", ["--headless", "--no-sandbox", "--disable-dev-shm-usage",
    "--ignore-certificate-errors", "--disable-background-networking", "--no-first-run", "--remote-debugging-pipe", "--user-data-dir=" + profile],
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
      if (result.method === "Network.responseReceived" && result.params.type === "Document") {
        const { response } = result.params;
        navigations.push({ path: new URL(response.url).pathname, status: response.status });
      }
      if (result.method === "Network.requestWillBeSent" && result.params.redirectResponse) {
        navigations.push({ path: new URL(result.params.redirectResponse.url).pathname, status: result.params.redirectResponse.status });
      }
      if (result.method === "Network.requestWillBeSentExtraInfo" && (result.params.headers.Origin || result.params.headers.origin)) {
        navigations.push({ origin: result.params.headers.Origin ?? result.params.headers.origin });
      }
      if (result.method === "Network.loadingFailed") navigations.push({ failure: result.params.errorText });
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
  await tab("Network.enable", {});
  for (const [name, value] of [["__Host-capy-session", session], ["__Host-capy-csrf", csrf]]) {
    assert.ok((await tab("Network.setCookie", { name, value, url: origin, path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).success);
  }
  async function clickFormButton(url, selector) {
    await tab("Page.navigate", { url });
    let clicked = false;
    for (let i = 0; i < 50 && !clicked; i++) {
      const evaluation = await tab("Runtime.evaluate", { expression: `(() => { const button = document.querySelector(${JSON.stringify(selector)}); if (button) button.click(); return !!button })()` });
      clicked = evaluation.result?.value === true;
      if (!clicked) await delay(50);
    }
    assert.ok(clicked, "Form button not rendered: " + selector);
  }
  for (const uri of [redirect, ipv6Redirect]) {
    for (const decision of ["allow", "deny"]) {
      await clickFormButton(authorize(client_id, uri), `button[value="${decision}"]`);
      const expected = new URL(uri).host + "/" + (decision === "allow" ? "allow" : "access_denied");
      for (let i = 0; i < 25 && !callbacks.includes(expected); i++) await delay(80);
      if (!callbacks.includes(expected)) failures.push("No callback for " + new URL(uri).hostname + " " + decision);
    }
  }
  await clickFormButton(origin + "/account?confirm=disconnect", 'form[action="/account/disconnect"] button');
  for (let i = 0; i < 25; i++) {
    if (await db.prepare("SELECT authorization_epoch FROM accounts WHERE id=?").bind(account).first("authorization_epoch") === 1) break;
    await delay(80);
  }
  assert.equal(await db.prepare("SELECT authorization_epoch FROM accounts WHERE id=?").bind(account).first("authorization_epoch"), 1,
    "Account form POST must pass the actual trusted Origin/CSRF guards");
  assert.deepEqual(failures, [], JSON.stringify({ failures, navigations }));
  assert.deepEqual(disclosures, []);
  console.log("PASS: workerd refused redirected CIMD; Chromium delivered Allow and Deny on both localhost and [::1] without a referrer/cookie, and submitted a guarded account disconnect.");
} finally {
  if (chrome && chrome.exitCode === null) { const closed = once(chrome, "exit"); chrome.kill(); await closed; }
  await mf.dispose();
  for (const server of [client, ipv6Client]) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
