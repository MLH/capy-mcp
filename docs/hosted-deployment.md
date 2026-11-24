# Hosted Capy MCP deployment runbook

This runbook is for an authorized operator. `wrangler.jsonc` uses placeholder origins and D1/KV IDs for local checks; `wrangler.production.jsonc` records the approved MLH target below. Get approval for the target and arrange secure provisioning before running any remote command. Keep test identity and intercepted network traffic out of the deployed Worker.

## Register one identity provider and set admission

Register one confidential OIDC web application with authorization code flow, S256 PKCE, and one exact web callback: `<PUBLIC_ORIGIN>/auth/callback`. Set `PUBLIC_ORIGIN` to the approved HTTPS origin with no trailing slash, path, or query. Use that origin consistently for the callback, account page, MCP resource and authorization-server discovery. OAuth clients have their own independently registered redirect URIs; don't add those to the IdP app. The Worker requests `openid email` for Google's exact issuer `https://accounts.google.com`, and `openid` for other issuers, then discovers the issuer's endpoints. Google requires an additional identity scope alongside `openid`; the email claim is not stored or used for identity or admission. The issuer and its discovered endpoints must be publicly reachable over HTTPS. Never use an arbitrary issuer selected by a browser or client.

Match the registration's token-endpoint authentication setting to discovery's `token_endpoint_auth_methods_supported`. The Worker uses `client_secret_post` whenever advertised, even when both methods are listed, so the app must accept POST in that case. It uses `client_secret_basic` only when POST is not advertised and Basic is advertised, or when the discovery field is absent. If neither supported method is advertised, sign-in fails. The Worker does not retry a rejected POST exchange with Basic.

Set the public values under `vars` in the approved Wrangler config:

| Setting | Value |
| --- | --- |
| `PUBLIC_ORIGIN` | Canonical HTTPS origin for this deployment. |
| `OIDC_ISSUER` | Exact issuer identifier from the provider's discovery document. |
| `OIDC_CLIENT_ID` | Registered OIDC web application client ID. |
| `OIDC_ALLOWED_SUBJECTS` | JSON array of exact, opaque `sub` values, or empty string if not used. |
| `OIDC_ADMISSION_CLAIM` | One signed ID-token claim name, or empty string if not used. |
| `OIDC_ALLOWED_CLAIM_VALUES` | JSON array of exact string values for that claim, or empty string if not used. |
| `CREDENTIAL_ENCRYPTION_KEY_ID` | Nonsecret version label for the one active encryption key. For example, `v1`; use 1–64 letters, digits, underscores or hyphens and a new label for each rotation. |
| `CAPY_TOOL_GROUPS` | Comma-separated group allowlist. Review the checked-in all-groups list against the deployment's needs. |
| `MCP_ALLOWED_ORIGINS` | Optional exact HTTP(S) client origins, comma-separated without spaces or slashes. Empty denies requests that carry a browser Origin. This is not CORS or an authentication bypass. |

Admission requires an explicit rule. If you set both a subject list and a claim policy, **both must match**. An empty JSON array denies all under that rule. Claim name and allowed values must be configured together; missing, nonstring, or unlisted claims deny admission. Identity is the verified pair `(issuer, sub)`, never email or a display name.

- **Google Workspace:** Register a Web application at Google and add the exact callback to its authorized redirect URIs. For example, set `OIDC_ISSUER` to `https://accounts.google.com`, the admission claim to `hd`, and the claim values to `["workspace.example.invalid"]` (replace the example with an approved Workspace domain). The signed hosted-domain claim is the authority; an email suffix or login screen hint is not.
- **Microsoft Entra:** Register a Web application for the approved tenant and add the exact callback. Use the tenant-specific v2 issuer `https://login.microsoftonline.com/<tenant-id>/v2.0` rather than `common` or `organizations`; set the admission claim to `tid` and the claim values to `["<tenant-id>"]` with the approved tenant ID. Confirm the registration issues v2 ID tokens with that issuer and claim. Use subjects from this app's tokens when limiting membership further.

The Google and Entra claim shapes are covered by signed fixtures. Real Google sign-in and callback were confirmed for the MLH deployment below; real Entra sign-in and a deliberately rejected real identity remain unverified.

## Provision and deploy to the approved target

### MLH deployment

The approved MLH target uses `wrangler.production.jsonc`, `https://capy-mcp.mlhtools.com`, Google project `capy-mcp`, D1 `capy-mcp-prod`, and KV `capy-mcp-oauth`. The application's admission rule checks Google's signed `hd` claim for `majorleaguehacking.com`; group admission is enforced separately by Cloudflare Access.

The **Capy MCP** self-hosted Access application is the hostname-wide default and allows only `sg-capy-mcp-access@majorleaguehacking.com` through the **Major League Hacking** Google Workspace identity provider. Keep this application and its group policy intact. Keep Access Managed OAuth disabled on the origin applications because the Worker already issues its own MCP OAuth challenges and tokens. Keep `workers_dev` and `preview_urls` disabled. This uses an Internet-facing Cloudflare edge, not private network routing.

#### MCP Portal protocol exceptions

On 2026-11-24, the operator approved retaining the application's per-user OAuth and exposing only its machine protocol paths through Access, without changing or redeploying application code. Whole-host Access had returned its own login redirect and Cloudflare Access metadata challenge to the Portal's backend, preventing discovery of the application's OAuth server.

A separate self-hosted Access application, **Capy MCP: app-owned OAuth protocol endpoints** (`57dfc156-998c-43ed-ae02-51d5620816e3`), has only these public destinations on `capy-mcp.mlhtools.com`:

| Path | Purpose |
| --- | --- |
| `/mcp` | MCP resource; the application still requires its own valid OAuth bearer token. |
| `/token` | Authorization-code exchange, refresh and revocation. |
| `/register` | OAuth client registration; registration alone grants no account or MCP access. |
| `/.well-known/oauth-authorization-server` | Application authorization-server metadata. |
| `/.well-known/oauth-protected-resource` | Protected-resource metadata namespace, including the actual `/mcp` metadata suffix. |

This application attaches reusable policy `ade8a8a7-79c6-4548-8b58-384c85e3225a`, with decision `bypass` and include `everyone`. It is hidden from the app launcher, with Managed OAuth and preflight bypass disabled. Cloudflare's [most-specific application path](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/) takes precedence over the hostname default; these paths and their descendants bypass Access enforcement and Access logging, while other zone controls still apply. Unsupported protocol descendants return application 404 responses. Do not broaden this to the hostname or general `/.well-known/*`.

Root, `/account`, `/auth/*`, `/authorize`, `/consent` and `/oauth/resume` remain behind the original group-restricted Access application. Browser authorization can authenticate through Access; server-side discovery, registration and token exchange must reach the application's OAuth directly. The Portal's separate `mcp` Access application for upstream `capy` retains the same group restriction. Do not enable origin Managed OAuth or replace individual Capy keys with a shared key.

These protocol endpoints are now Internet-reachable, not anonymously authorized. Application identity remains `(issuer, sub)`, with signed `hd` admission, individual encrypted Capy keys, scope consent and authoritative D1 grant revocation. Group membership is checked by Access on the browser flow, not on every application bearer-token request. Removing someone from the group does not itself revoke their existing application grants; use the revocation/offboarding procedure below.

Live anonymous checks confirmed application JSON metadata with the canonical issuer/resource, 401 Bearer challenges for unauthenticated MCP GET/POST/OPTIONS and invalid tokens, and application OAuth errors for invalid token exchanges and registration requests. The bare protected-resource namespace returns 404; the advertised `/.well-known/oauth-protected-resource/mcp` returns 200. Browser/account/authorization routes still redirect to Access. The Worker version and telemetry settings were unchanged. This proves routing and anonymous denial, not successful Portal OAuth, capability sync or an authorized tool call.

Retry **Authenticate** on the existing `capy` upstream, configured with `https://capy-mcp.mlhtools.com/mcp`, OAuth and the shared OAuth callback. Complete the personal Google/Access sign-in and application consent, then verify capability sync and one safe read. Preserve per-person authorization when mapping it into a Portal; no Portal mapping was changed by the exception setup. Refresh/revocation through the Portal, a denied real identity, deployed telemetry privacy and backup restoration still need live verification.

To roll back the exceptions, delete only Access application `57dfc156-998c-43ed-ae02-51d5620816e3`, leaving the hostname-wide application and its group policy untouched. Verify anonymous protocol requests again redirect to Access; the Portal will stop working until a compatible route is restored. Remove the reusable bypass policy only if unused. This rollback changes no Worker code, secrets, D1/KV state or existing grants. Use the same production config for migration and deployment commands below.

### Operator procedure

1. With the approved Cloudflare credentials and target selected, provision a dedicated D1 database and KV namespace. The Wrangler commands are `npx wrangler d1 create <approved-database-name>` and `npx wrangler kv namespace create <approved-namespace-name>`. Use their actual names/IDs for `DB` and `OAUTH_KV`; never point an environment at someone else's resources. Set distinct numeric rate-limit namespace IDs for `AUTH_RATE_LIMITER` (login and public OAuth endpoints) and `ACCOUNT_RATE_LIMITER` (account and consent mutations); review limits against shared-IP traffic. Use separate bindings and secrets per environment. Keep preview URLs off, and configure the approved route or workers.dev hostname to match `PUBLIC_ORIGIN`. A network-reachable Worker is not a private network.
2. Start with `npm ci`, `npm run check:provider`, and the checks in [CONTRIBUTING.md](../CONTRIBUTING.md). Run `npx wrangler deploy --config <approved-config> --dry-run --outdir dist/worker`, without secrets, to check bundle and binding shape. A dry run doesn't check remote bindings, deployed logs, or login. After reviewing migrations and protecting any existing database, run `npx wrangler d1 migrations list DB --remote --config <approved-config>` and `npx wrangler d1 migrations apply DB --remote --config <approved-config>`, then list again to confirm none are pending. Include the same `--env` everywhere if using a named environment.
3. Provision the two required secrets in `.secrets.production.json` at the repository root (the only Git-ignored path for that filename), or use a protected file outside the checkout supplied by the operator’s secret manager. Use a restrictive umask (`077`) and mode `0600`. Enter literal JSON string values, normally escaped for JSON. Do not use dotenv substitution, `vars`, command-line values, shell history, or chat:

   ```json
   {
     "OIDC_CLIENT_SECRET": "<registered confidential client secret>",
     "CREDENTIAL_ENCRYPTION_KEY": "<standard base64 of 32 random bytes>"
   }
   ```

   Generate the master key in the approved secret environment and escrow it with its key ID. Valid JSON is parsed literally by Wrangler; dollar expressions in secret values are not expanded or replaced by process environment variables. Do not feed the secrets file into the credential-free checks.
4. Only with deployment approval, run `npx wrangler deploy --config <approved-config> --secrets-file <actual-protected-file-path>`. For the root file, use `./.secrets.production.json` from the repository root; otherwise pass the actual absolute path supplied by the secret manager. Securely remove the working copy when no longer needed; keep the approved secrets in the secret manager. For code-only deployments, use the same approved configuration and existing required secrets. `wrangler secret put` creates **and deploys** a version immediately; stage coordinated changes via the approved version rollout instead of independently changing live fields.
5. Read back the hostname, resource IDs, required secret names and [observability settings](../SECURITY.md#observability) without dumping values. In a fresh browser and authorized test client, check discovery, an admitted and rejected identity, a read-only grant, one safe read, and account revocation. Check that a new request fails after revoke. Review only sanitized telemetry. Record which real client and provider you actually verified before claiming compatibility.

The former hosted `MCP_AUTH_TOKEN` and deployment-wide `CAPY_API_KEY` are not accepted or used as a fallback. Remove any obsolete hosted bindings via the authorized configuration change, revoke obsolete credentials with their issuers, and have clients reconnect over OAuth. STDIO still uses its own process-local `CAPY_API_KEY`.

## Operate and recover

- **Principal and grants.** Each hosted account supplies one Capy key. Capy sees the principal owning that key, which may be a different person or service user from the OIDC subject. Key validation is a scoped `projects.list` call; validation does not compare identities or grant extra access. Minimize principal roles, project access and spending. `capy:read` allows enabled upstream GET tools; `capy:write` adds non-GET tools only with explicit consent; `offline_access` allows refresh after the browser leaves. The upstream principal and enabled groups still constrain both read and write. The provider defaults to a one-hour access token and a 30-day refresh-token lifetime, with refresh rotation. A browser sign-out does not revoke a client or remove its key.
- **Offboarding.** Login state expires after 10 minutes; browser sessions last at most one hour. Hosted requests and token exchanges re-evaluate the current admission policy against stored signed identity attributes; they do not poll the IdP. Disabling an IdP account prevents a fresh login once enforced by that IdP, but does not immediately evict an existing local session, and expiry of the browser session does not end an offline OAuth grant. A later signed login that shows claim withdrawal updates the stored admission data; blocked IdP users may never reach that step. For timely offboarding, remove the subject from a configured allowlist (adopt one if a broad claim alone can't exclude the account), revoke the relevant grant locally, or revoke the Capy key with Capy where necessary. Don't rely on IdP disablement or refresh expiry as the immediate cutoff.
- **Revoke or change a key.** Use `/account` to revoke one client, disconnect all clients, replace the key, or remove it. A committed D1 revocation/version change blocks new authorized calls and refreshes without waiting for OAuth KV cleanup. It cannot retract work already accepted by Capy or undo an in-flight mutation. After a timeout, cancellation, or revoke during a mutation, check the upstream outcome before retrying. Removing a stored key is separate from revoking the key in Capy.
- **Encrypt and rotate.** D1 stores AES-256-GCM envelopes with fresh nonces and account/version-bound associated data. The running Worker and anyone with the key plus ciphertext can decrypt; this isn't zero-knowledge. One active key is supported; there is no automatic re-encryption. Plan a maintenance window, protect the current database backup and matching key separately, and stop access before switching. Provision the new key and key ID together. Old envelopes no longer decrypt; have users replace their keys in `/account` and reauthorize their clients. Replacement invalidates grants from the old credential version. If the master key is lost, recover the matching approved escrow copy or have users reconnect under a new key; there is no ciphertext recovery without it. If it was exposed, treat stored Capy keys as potentially compromised and rotate or revoke them at Capy as well.
- **Backups and restoration.** Limit D1 backup access and retention, and keep the matching master key outside database backups in the authorized secret manager. Restrict KV access too: it carries OAuth grant and token material. Never restore a snapshot over live authorization state without reconciling revocations and offboarding since the snapshot. When unsure, provision fresh OAuth KV, invalidate old application grants and sessions before serving traffic, and require fresh sign-in and consent; encrypted keys need either the corresponding key or re-entry. Test restore in an isolated environment. A Worker version rollback doesn't roll back D1/KV and does not safely undo a key rotation or migration by itself.
