import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import {
  accessDeniedPage, accountPage, confirmationPage, connectForConsent, consentComplete, consentPage, signInPage,
} from "../../src/hosted/pages.js";

const client: ConsentDescription = {
  clientId: "fixture-client",
  clientName: "Example MCP client",
  redirectUri: "http://localhost:1234/callback",
  redirectHost: "localhost:1234",
  redirectIsLoopback: true,
  scope: ["capy:read", "capy:write", "offline_access"],
};
const account = { subject: "demo-member", connected: false, generation: 2, clients: [], csrf: "fixture-csrf" };
const callback = "http://localhost:1234/callback?code=fixture-code&state=fixture-state";
const completion = () => consentComplete(callback, new Headers({
  Location: callback, "Set-Cookie": "__Host-oauth-consent=; Path=/; Max-Age=0",
}));

it.each([
  { name: "sign-in", render: signInPage, status: 401, referrer: "no-referrer" },
  { name: "onboarding", render: () => connectForConsent("fixture-csrf", "transaction"), status: 200, referrer: "strict-origin" },
  { name: "consent", render: () => consentPage(client, account.subject, "fixture-handle", account.csrf), status: 200, referrer: "strict-origin" },
  { name: "completion", render: completion, status: 200, referrer: "no-referrer" },
  { name: "access denied without sign-out", render: () => accessDeniedPage(null), status: 403, referrer: "no-referrer" },
  { name: "access denied with sign-out", render: () => accessDeniedPage(account.csrf), status: 403, referrer: "strict-origin" },
  { name: "disconnected account", render: () => accountPage(account), status: 200, referrer: "strict-origin" },
  { name: "connected account", render: () => accountPage({ ...account, connected: true, clients: [
    { id: "fixture-grant", label: client.clientName, scopes: ["capy:read"], grantedAt: "2026-11-24T12:00:00Z" },
  ] }), status: 200, referrer: "strict-origin" },
  { name: "remove key", render: () => confirmationPage({ kind: "delete", generation: 2 }, account.csrf), status: 200, referrer: "strict-origin" },
  { name: "disconnect clients", render: () => confirmationPage({ kind: "disconnect" }, account.csrf), status: 200, referrer: "strict-origin" },
  { name: "revoke client", render: () => confirmationPage({ kind: "revoke", id: "fixture-grant", label: client.clientName }, account.csrf), status: 200, referrer: "strict-origin" },
])("serves only the authorized static style on the $name page", async ({ render, status, referrer }) => {
  const response = render();
  const html = await response.text();
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Referrer-Policy")).toBe(referrer);
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  const styles = [...html.matchAll(/<style>([\s\S]+?)<\/style>/g)];
  expect(styles).toHaveLength(1);
  const css = styles[0][1];
  expect(css).toBe((await signInPage().text()).match(/<style>([\s\S]+?)<\/style>/)?.[1]);
  const hash = createHash("sha256").update(css, "utf8").digest("base64");
  expect(response.headers.get("Content-Security-Policy")).toBe(
    `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'sha256-${hash}'`,
  );
  expect(css).not.toMatch(/@import|@font-face|url\s*\(/i);
  expect(html).not.toMatch(/<(?:script|link|img|iframe|object|embed|source)\b|<[^>]+\s(?:src|srcset|style|on\w+)=/i);
  expect(html).not.toMatch(/<[^>]+\s(?:href|action)="(?!\/(?!\/))/i);
});

it("keeps completion cookies and navigation in headers only", async () => {
  const response = completion();
  expect(response.headers.has("Location")).toBe(false);
  expect(response.headers.get("Refresh")).toBe(`0; url="${callback}"`);
  expect(response.headers.getSetCookie()).toEqual(["__Host-oauth-consent=; Path=/; Max-Age=0"]);
  const html = await response.text();
  expect(html).toContain("<h1>Returning to your MCP client</h1>");
  expect(html).not.toMatch(/localhost|fixture-code|fixture-state|<form|http-equiv/i);
});

it("escapes consent display values and preserves the explicit consent fields", async () => {
  const html = await consentPage({
    ...client, clientName: "<client>", clientDomain: "<domain>", redirectHost: "<host>",
    redirectUri: "http://localhost:1234/callback?a=b&x=y", scope: [...client.scope, "<scope>"],
    clientUri: "https://external.example.invalid/client", logoUri: "https://external.example.invalid/logo",
  }, "<identity>", 'handle"fixture', 'csrf"fixture').text();
  for (const value of ["client", "domain", "host", "scope", "identity"]) {
    expect(html).toContain(`&lt;${value}&gt;`);
    expect(html).not.toContain(`<${value}>`);
  }
  expect(html).toContain("/callback?a=b&amp;x=y");
  expect(html).not.toContain("external.example.invalid");
  expect(html).toContain('method="post" action="/consent"');
  expect(html).toContain('type="hidden" name="csrf" value="csrf&quot;fixture"');
  expect(html).toContain('type="hidden" name="handle" value="handle&quot;fixture"');
  expect(html.match(/<input\b[^>]*name="write"[^>]*>/)?.[0]).toBe('<input type="checkbox" name="write" value="yes">');
  expect(html.match(/name="decision" value="(?:allow|deny)"/g)).toEqual(['name="decision" value="allow"', 'name="decision" value="deny"']);
});

it("retains the onboarding transaction target and an empty password input", async () => {
  const html = await connectForConsent('csrf"&', "one/two?three").text();
  expect(html).toContain('method="post" action="/account/key?transaction=one%2Ftwo%3Fthree"');
  expect(html).toContain('type="hidden" name="csrf" value="csrf&quot;&amp;"');
  const password = html.match(/<input\b[^>]*type="password"[^>]*>/)?.[0];
  expect(password).toContain('name="key" required');
  expect(password).toContain('autocomplete="off" spellcheck="false"');
  expect(password).not.toContain("value=");
});
