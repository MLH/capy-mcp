import { browserResponse } from "./browser.js";
import { MAX_CREDENTIAL_BYTES } from "./crypto.js";
import { hostedStyles, hostedStyleSource } from "./styles.js";
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const ACCOUNT_LOGIN_PATH = "/auth/login";
export const ACCOUNT_LOGOUT_PATH = "/auth/logout";

const escaped: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => escaped[character]);
}

function documentPage(heading: string, title: string, content: string, init: ResponseInit): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  const response = browserResponse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>${hostedStyles}</style></head>
<body><main><div class="wordmark" aria-hidden="true">CAPY / MCP</div><h1>${escapeHtml(heading)}</h1>${content}</main></body></html>`, { ...init, headers });
  response.headers.set("Content-Security-Policy", `${response.headers.get("Content-Security-Policy")}; style-src ${hostedStyleSource}`);
  return response;
}

function page(title: string, content: string, status = 200): Response {
  const response = documentPage(title, `${title} · Capy MCP`, content, { status });
  if (status === 200) response.headers.set("Referrer-Policy", "strict-origin");
  return response;
}

export function signInPage(): Response {
  return page("Sign in to Capy MCP", `<p>Sign in with your configured identity provider to manage your Capy connection.</p>
<p><a class="button" href="${ACCOUNT_LOGIN_PATH}">Sign in</a></p>`, 401);
}

export function connectForConsent(csrf: string, id: string): Response {
  return page("Connect your Capy key", `<p class="notice">Your client will use the full upstream authority of this key, which may belong to another Capy user.
  After connecting, review the client's request before granting access.</p>
  ${postForm("/account/key?transaction=" + encodeURIComponent(id), csrf, "Connect and continue",
    `<p><label>Capy API key <input type="password" name="key" required maxlength="${MAX_CREDENTIAL_BYTES}" autocomplete="off" spellcheck="false"></label></p>`)}`);
}

export function consentPage(client: ConsentDescription, subject: string, handle: string, csrf: string): Response {
  return page("Authorize MCP client", `<p>Signed in as <bdi>${escapeHtml(subject)}</bdi>.</p>
  <p><strong>Client:</strong> <bdi>${escapeHtml(client.clientName)}</bdi> (${client.clientDomain ? "verified domain: " + escapeHtml(client.clientDomain) : "unverified name"}).</p>
  <p><strong>Redirect destination:</strong> <bdi>${escapeHtml(client.redirectHost)}</bdi> · <code>${escapeHtml(client.redirectUri)}</code>.</p>
  ${client.redirectIsLoopback ? '<p class="notice">This is a local app. Any local process could be listening.</p>' : ""}
  <p class="scopes"><strong>Requested permissions:</strong> ${client.scope.map(s => `<code>${escapeHtml(s)}</code>`).join(", ")}. Read access lets this client read Capy data.</p>
  ${client.scope.includes("offline_access") ? "<p>Offline access lets the client refresh its access after you leave.</p>" : ""}
  <form method="post" action="/consent"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  ${client.scope.includes("capy:write") ? '<label class="choice"><input type="checkbox" name="write" value="yes"> Allow write operations, including billable work and organization changes</label>' : ""}
  <div class="actions"><button name="decision" value="allow">Allow</button> <button class="secondary" name="decision" value="deny">Deny</button></div></form>`);
}

export function consentComplete(redirectTo: string, providerHeaders: Headers): Response {
  const headers = new Headers(providerHeaders);
  headers.delete("Location");
  headers.set("Refresh", `0; url="${redirectTo}"`);
  const title = "Returning to your MCP client";
  return documentPage(title, title, "<p>If your browser blocks automatic navigation, allow it or restart authorization in your client.</p>", { headers });
}

export function accessDeniedPage(csrf: string | null): Response {
  const response = page("Access denied", `<p>This identity isn't allowed to use this Capy MCP deployment.</p>
<p><a class="button" href="${ACCOUNT_LOGIN_PATH}">Sign in again</a></p>${csrf ? postForm(ACCOUNT_LOGOUT_PATH, csrf, "Sign out", "", "secondary") : ""}`, 403);
  if (csrf) response.headers.set("Referrer-Policy", "strict-origin");
  return response;
}

interface AccountView {
  subject: string;
  connected: boolean;
  generation: number;
  clients: readonly { id: string; label: string; scopes: readonly string[]; grantedAt: string | null }[];
  csrf: string;
}

function postForm(action: string, csrf: string, button: string, fields = "", variant?: "secondary" | "danger"): string {
  return `<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">${fields}
<button type="submit"${variant ? ` class="${variant}"` : ""}>${escapeHtml(button)}</button></form>`;
}

export function accountPage({ subject, connected, generation, clients, csrf }: AccountView): Response {
  const keyInput = `<input type="hidden" name="generation" value="${generation}"><p><label for="capy-key">Capy API key</label>
<input id="capy-key" type="password" name="key" required maxlength="${MAX_CREDENTIAL_BYTES}" autocomplete="off" spellcheck="false"></p>`;
  const grantList = clients.length ? `<ul class="grants" role="list">${clients.map(({ id, label, scopes, grantedAt }) => `<li>
<p><strong><bdi>${escapeHtml(label)}</bdi></strong> — ${scopes.map((scope) => `<code>${escapeHtml(scope)}</code>`).join(", ")}
${grantedAt ? ` <span class="grant-date">· Granted <time datetime="${escapeHtml(grantedAt)}">${escapeHtml(grantedAt)}</time></span>` : ""}</p>
<a class="danger" href="/account?confirm=revoke&amp;grant=${encodeURIComponent(id)}">Revoke this client</a></li>`).join("")}</ul>`
    : "<p>No authorized MCP clients. To connect or reconnect one, start authorization in your MCP client.</p>";
  return page("Your Capy MCP account", `<p>Signed in as <bdi>${escapeHtml(subject)}</bdi>.</p>
<section><h2>Capy connection</h2>
<p><strong class="status">${connected ? "Capy key connected" : "No Capy key connected"}</strong></p>
<p class="notice">Calls to Capy use the supplied key's full upstream authority. The key can belong to a different Capy user or service user than your sign-in identity.</p>
${connected ? "<p>Replacing the key disconnects existing MCP clients. They need your consent to reconnect.</p>" : ""}
${postForm("/account/key", csrf, connected ? "Replace key" : "Connect key", keyInput)}
${connected ? '<p><a class="danger" href="/account?confirm=delete">Remove key from this deployment</a></p>' : ""}
<p>To revoke the API key itself everywhere it is used, revoke it in Capy.</p></section>
<section><h2>Authorized MCP clients</h2>${grantList}
${clients.length ? '<p><a class="danger" href="/account?confirm=disconnect">Disconnect all clients</a></p>' : ""}
<p>Revocation blocks new calls; it cannot undo calls already in flight.</p></section>
<section><h2>Sign out</h2><p>Signing out ends this browser session. It does not disconnect clients or remove the Capy key.</p>
${postForm(ACCOUNT_LOGOUT_PATH, csrf, "Sign out", "", "secondary")}</section>`);
}

type Confirmation = { kind: "delete"; generation: number } | { kind: "disconnect" } | { kind: "revoke"; id: string; label: string };

export function confirmationPage(confirmation: Confirmation, csrf: string): Response {
  const [title, message, action] = confirmation.kind === "revoke"
    ? ["Revoke this client", `Disconnect <bdi>${escapeHtml(confirmation.label)}</bdi>. Other clients, the key, and this browser session are unchanged.`,
      `/account/grants/${encodeURIComponent(confirmation.id)}/revoke`]
    : confirmation.kind === "delete"
      ? ["Remove Capy key", "Remove the key from this deployment and disconnect all clients. This does not revoke the key in Capy.", "/account/key/delete"]
      : ["Disconnect all clients", "Disconnect every MCP client. The Capy key and this browser session are unchanged.", "/account/disconnect"];
  return page(title, `<p>${message} Clients must request authorization again. Calls already in flight cannot be undone.</p>
${postForm(action, csrf, title, confirmation.kind === "delete" ? `<input type="hidden" name="generation" value="${confirmation.generation}">` : "", "danger")}<p><a href="/account">Cancel</a></p>`);
}
