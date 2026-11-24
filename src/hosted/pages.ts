import { browserResponse } from "./browser.js";
import { MAX_CREDENTIAL_BYTES } from "./crypto.js";

export const ACCOUNT_LOGIN_PATH = "/auth/login";
export const ACCOUNT_LOGOUT_PATH = "/auth/logout";

const escaped: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => escaped[character]);
}

function page(title: string, content: string, status = 200): Response {
  return browserResponse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Capy MCP</title></head>
<body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`, {
    status, headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function signInPage(): Response {
  return page("Sign in to Capy MCP", `<p>Sign in with your configured identity provider to manage your Capy connection.</p>
<p><a href="${ACCOUNT_LOGIN_PATH}">Sign in</a></p>`, 401);
}

export function accessDeniedPage(): Response {
  return page("Access denied", `<p>This identity isn't allowed to use this Capy MCP deployment.</p>
<p><a href="${ACCOUNT_LOGIN_PATH}">Sign in with a different identity</a></p>`, 403);
}

interface AccountView {
  subject: string;
  connected: boolean;
  clients: readonly { id: string; label: string; scopes: readonly string[]; grantedAt: string | null }[];
  csrf: string;
}

function postForm(action: string, csrf: string, button: string, fields = ""): string {
  return `<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">${fields}
<button type="submit">${escapeHtml(button)}</button></form>`;
}

export function accountPage({ subject, connected, clients, csrf }: AccountView): Response {
  const keyInput = `<p><label for="capy-key">Capy API key</label>
<input id="capy-key" type="password" name="key" required maxlength="${MAX_CREDENTIAL_BYTES}" autocomplete="off" spellcheck="false"></p>`;
  const grantList = clients.length ? `<ul>${clients.map(({ id, label, scopes, grantedAt }) => `<li>
<p><strong><bdi>${escapeHtml(label)}</bdi></strong> — ${scopes.map((scope) => `<code>${escapeHtml(scope)}</code>`).join(", ")}
${grantedAt ? ` · Granted <time datetime="${escapeHtml(grantedAt)}">${escapeHtml(grantedAt)}</time>` : ""}</p>
<a href="/account?confirm=revoke&amp;grant=${encodeURIComponent(id)}">Revoke this client</a></li>`).join("")}</ul>`
    : "<p>No authorized MCP clients. To connect or reconnect one, start authorization in your MCP client.</p>";
  return page("Your Capy MCP account", `<p>Signed in as <bdi>${escapeHtml(subject)}</bdi>.</p>
<section><h2>Capy connection</h2>
<p><strong>${connected ? "Capy key connected" : "No Capy key connected"}</strong></p>
<p>Calls to Capy use the supplied key's full upstream authority. The key can belong to a different Capy user or service user than your sign-in identity.</p>
${connected ? "<p>Replacing the key disconnects existing MCP clients. They need your consent to reconnect.</p>" : ""}
${postForm("/account/key", csrf, connected ? "Replace key" : "Connect key", keyInput)}
${connected ? '<p><a href="/account?confirm=delete">Remove key from this deployment</a></p>' : ""}
<p>To revoke the API key itself everywhere it is used, revoke it in Capy.</p></section>
<section><h2>Authorized MCP clients</h2>${grantList}
${clients.length ? '<p><a href="/account?confirm=disconnect">Disconnect all clients</a></p>' : ""}
<p>Revocation blocks new calls; it cannot undo calls already in flight.</p></section>
<section><h2>Sign out</h2><p>Signing out ends this browser session. It does not disconnect clients or remove the Capy key.</p>
${postForm(ACCOUNT_LOGOUT_PATH, csrf, "Sign out")}</section>`);
}

type Confirmation = { kind: "delete" | "disconnect" } | { kind: "revoke"; id: string; label: string };

export function confirmationPage(confirmation: Confirmation, csrf: string): Response {
  const [title, message, action] = confirmation.kind === "revoke"
    ? ["Revoke this client", `Disconnect <bdi>${escapeHtml(confirmation.label)}</bdi>. Other clients, the key, and this browser session are unchanged.`,
      `/account/grants/${encodeURIComponent(confirmation.id)}/revoke`]
    : confirmation.kind === "delete"
      ? ["Remove Capy key", "Remove the key from this deployment and disconnect all clients. This does not revoke the key in Capy.", "/account/key/delete"]
      : ["Disconnect all clients", "Disconnect every MCP client. The Capy key and this browser session are unchanged.", "/account/disconnect"];
  return page(title, `<p>${message} Clients must request authorization again. Calls already in flight cannot be undone.</p>
${postForm(action, csrf, title)}<p><a href="/account">Cancel</a></p>`);
}
