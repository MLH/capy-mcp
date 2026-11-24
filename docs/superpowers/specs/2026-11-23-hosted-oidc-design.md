# Hosted OIDC and per-user Capy credentials

Status: agreed direction; implementation design awaiting approval. This extends the original single-principal design. Erin approved generic OIDC sign-in, initially Google Workspace for MLH, encrypted per-user Capy keys, and MCP OAuth for remote clients. Existing STDIO is proven useful and must remain independent of hosted authentication.

## Intent

Deploy one team-usable remote MCP endpoint on Cloudflare Workers. Each admitted person connects their own chosen Capy API key once in a browser and authorizes MCP clients without handing those clients the key. An open-source operator can use Google, Microsoft Entra ID, or another standards-compliant OIDC provider through configuration instead of editing provider-specific application code.

The existing 102 tools, generated validators, group filtering, upstream safety bounds, and stateless request-local MCP execution remain the foundation. The hosted change replaces the shared MCP bearer and deployment-wide Capy key, not the actual Capy API or its authorization rules. No more investigation of the ChatGPT-specific local-launch issue is part of this work.

## Approaches

1. **Configurable OIDC sign-in plus our MCP OAuth authorization server — selected by Erin.** Users identify themselves through an existing organization identity provider. We retain the separate Capy credential and issue audience-bound MCP tokens. Operators configure one issuer per installation. This adds a small account/key-management site and persistent authorization state but preserves client portability and per-person authority.
2. **Hard-coded Google login.** Simpler provider-specific setup, but changing identity systems would require code changes. Rejected in favor of OIDC.
3. **Keep a shared bearer/key or deploy one Worker per user.** Avoids a credential vault but does not meet the requested team onboarding and personal-key model. Not the hosted product being built.

Builder recommendation: use one Worker for the account site, OIDC relying party, MCP OAuth provider, and resource endpoint. Cloudflare's supported `OAuthProvider` combines these roles; split Workers are unnecessary for a single resource. Use maintained OIDC/OAuth libraries rather than implementing token validation, PKCE, discovery, or client registration ourselves. Pin published versions after checking their actual types against current documentation.

## Account identity and admission

- Configure one HTTPS OIDC issuer, client ID, client authentication secret, and fixed public origin/callback URI per deployment. Discovery is from the configured issuer only; users cannot supply an issuer, discovery URL, token endpoint, or callback host.
- Use Authorization Code with S256 PKCE, browser-bound single-use state, and nonce. Require a validated ID token and check signature, exact issuer, audience/authorized party, expiry, and nonce through the OIDC library. Do not use unverified token claims or user-supplied email as identity.
- A local account maps uniquely to the tuple of verified `iss` and `sub`. Email/display name are optional presentation metadata, not primary keys or automatic account-linking inputs. Changing issuer does not silently migrate or merge accounts.
- Sign-in is not admission. Require an explicit operator-configured policy; no policy means deny. Support an exact subject allowlist and/or an exact allowlist for one operator-selected signed ID-token claim. Builder recommendation: when both are configured, both must match (AND); a subject entry cannot bypass the configured organization boundary. Reject unknown/missing/wrongly typed claims and unsupported policy shapes. For Google Workspace, use the verified hosted-domain claim; for Entra, use a tenant-specific issuer and verified tenant claim. Do not substitute an email suffix or a login-screen domain hint for membership enforcement.
- There is one provider per deployment, not a provider picker, identity broker, or account-linking system. Google/Entra configuration examples must explain each provider's registration and admission claim without claiming a live integration test that did not occur.
- Evaluate current configured admission rules when authorizing browser operations and dispatching MCP calls using the stored verified identity attributes. Preserve only the admission attributes needed. Account disablement or local credential revocation must take effect without waiting for a cached Capy credential. Identity-provider offboarding alone is bounded by reauthentication/session policy, not claimed to be instantaneous.

## Browser onboarding and credential management

Provide a small server-rendered site, no separate frontend service:

1. An unauthenticated visitor signs in with the configured OIDC provider. An unadmitted identity receives a clear access-denied page and no credential form or MCP authorization grant.
2. The signed-in account page reports whether a Capy key is connected, never the plaintext or a recoverable value. A user can add, replace, or delete their own key. Keys are submitted only in HTTPS POST bodies, never query strings, redirect URLs, logs, analytics, or client-side persistence.
3. Before storing a submitted key, make one bounded, read-only request to Capy's fixed `/api/v1/projects` endpoint. Do not create work or exhaust pagination. A failed validation leaves any previous key unchanged and yields a sanitized error. Do not assume the key principal is the OIDC identity: the user may intentionally choose a personal or service-user key. Explain that calls have the supplied key's full upstream authority.
4. Show the user their authorized MCP client grants and allow individual revocation or disconnect-all. Builder recommendation: both actions must block new upstream calls immediately after the successful revocation response, even when the Capy key is retained. An authoritative D1 per-grant record and account authorization epoch, checked on every dispatch without cached credentials or stale replica reads, enforce that boundary independently of OAuth KV propagation. Use an opaque application grant ID bound into verified OAuth token props, not client-selected grant IDs. Deleting the Capy key immediately blocks new upstream calls through all grants. Replacing a key invalidates grants bound to the previous credential version, so an existing client cannot silently inherit another principal's key; reconnecting requires consent. Already-accepted/in-flight mutations cannot be undone by revocation.
5. Logout invalidates the browser session and expires its cookie. It is separate from disconnecting MCP clients or revoking the Capy key in Capy. Explain each action explicitly.

Use opaque browser sessions in D1, store only hashed session identifiers, and set Secure/HttpOnly/SameSite cookies with `__Host-` names. Bind login state to the browser, expire and consume it atomically, rotate session identity at login, and reject callback replay. Protect all state-changing account/consent actions with CSRF tokens and exact trusted Origin checks. Use a restrictive CSP, no third-party scripts, no secret-bearing HTML, no framing, no arbitrary return URL, and no secrets in error output. Render escaped identity/client metadata. Do not weaken protection to make a particular MCP client connect.

## MCP OAuth and scope enforcement

Use Cloudflare Workers OAuth Provider for standard protected-resource and authorization-server metadata, authorization code exchange with PKCE, consent, token expiry/refresh, and revocation. Support the provider's vetted client-ID metadata and dynamic registration mechanisms required by general MCP clients. Bound request bodies and use the provider's SSRF-safe public-fetch requirements for client-supplied metadata URLs. Do not invent permissive callback matching or token passthrough.

The consent page identifies the requesting client and actual redirect destination, offers allow/deny, and states the requested authority. Library-provided browser binding and stored request handles must be preserved; the browser form cannot replace client, redirect URI, resource, or scope values.

- Define `capy:read`, `capy:write`, and the library's refresh/offline scope as appropriate. Default initial access is read-only. A client needs explicit write consent for mutations, which may start billable work or change organization settings.
- Enforce the intersection of deployment API groups, current valid account/credential version, and token scopes in both `tools/list` and `tools/call`. A direct call to a hidden or write-denied tool must fail before fetch. Use the catalog's actual upstream method to distinguish GET reads from mutations; MCP itself uses POST even for read tools, so the outer HTTP method must not determine authority.
- MCP tokens are issued for this deployment's canonical `/mcp` resource and accepted only for it. An upstream OIDC token or Capy key is not an MCP access token. Token props contain only opaque account ID and credential/grant version metadata, never the Capy key.
- Every authenticated request resolves the current account and credential from storage. Do not use a deployment-wide fallback key, choose credentials from client arguments, cache decrypted keys globally, or permit cross-user credential selection.
- Keep active HTTP cancellation, deadlines, response limits, generated validation, safe API error mapping, and concurrent-request isolation. Independent cancellation-notification POSTs still cannot route to earlier request-local servers; no MCP session registry is added.

A request lacking a valid token receives the proper OAuth challenge. A missing/revoked/expired upstream credential gets a reconnect-needed result or account link without revealing another user's state or echoing a key. Browser account routes and OAuth protocol endpoints have their own intended methods; the MCP endpoint remains finite Streamable HTTP, not legacy SSE.

## Persistent state and encryption

Use Cloudflare D1 for accounts, credential versions/ciphertext, application grant revocation state, browser sessions, and single-use login state; use the OAuth provider's required KV binding for its grants/tokens. Keep those namespaces separate from application credentials. Schemas have explicit migrations and uniqueness constraints; database operations use bound parameters. Do not store OIDC access/refresh tokens if authentication does not need them after ID-token validation.

Encrypt each Capy key with Web Crypto AES-256-GCM, a fresh cryptographic nonce, and authenticated associated data binding the row's account identity and credential version. Store an envelope version/key identifier, nonce, and ciphertext only. Keep the encryption master key in a Worker secret, not D1/KV or repository configuration. Define bounded input lengths and reject malformed envelopes or authentication failures without returning plaintext/error internals. Database-only access must not be enough to decrypt a key.

Document backups and master-key custody honestly: the running Worker/operator with the encryption key can decrypt credentials; encryption is not zero-knowledge. The first release uses one configured active encryption key and a documented maintenance/re-onboarding procedure for rotation; no silent destructive key replacement or unaudited bulk re-encryption job. Lost master keys require reconnecting users. Do not promise instant global OAuth KV revocation; D1 credential/version checks provide the immediate application-level disconnect boundary for new calls.

Rate-limit public authorization/registration, login callbacks, credential submissions, and grant-management actions using deployment-appropriate Workers facilities. Limits must not be keyed by untrusted identity headers or silently bypassed when optional infrastructure is absent. Exact thresholds and library-specific storage details belong to implementation planning, with tests for fail-closed behavior.

## Compatibility and deployment

- STDIO continues using `CAPY_API_KEY` and optional groups, with no OIDC, D1, or KV dependency for local use. Preserve all existing STDIO tests and the npm artifact's local-only dependency boundary.
- Hosted mode requires OIDC configuration, admission policy, encryption/session secrets, D1, and OAuth KV. It must not accept the old shared `MCP_AUTH_TOKEN` or use the old hosted `CAPY_API_KEY` as a fallback. Document this as the hosted breaking change. The previous prototype is not yet deployed, so no production user migration is required.
- Deployment remains self-hostable on Workers with one canonical HTTPS origin and no hard-coded MLH domain, Google account, Cloudflare account ID, or production database ID. MLH's actual issuer/admission values, account, hostname, and OAuth client registration are deployment configuration, not invented defaults.
- Keep logs/traces enabled without credential/authorization-body logging. Review automatic instrumentation so callback codes, cookies, Authorization headers, and key POST bodies are not captured. No session identifiers or plaintext API keys in screenshots, attachments, test fixtures, or PR media.
- Provide separate local fake-OIDC fixtures and development secrets, migration/dry-run commands, operator setup, example Google/Entra configurations, browser onboarding, client-neutral connection instructions, and revoke/rotate/recovery guidance. Examples must not imply tested Duet/Dot/ChatGPT live compatibility.
- Do not change project Setup, teammates' local config, or unrelated app diagnostics. No credentials are requested in chat or committed. Creating remote D1/KV/Worker resources, registering the OIDC application, or deploying needs an identified operator-approved target and secret provisioning; stop at that concrete boundary when unavailable. The user has requested shipping to Workers, not permission to choose an arbitrary account or expose an unprotected interim deployment.
- Remain private/unpublished until MLH chooses a license. No public release is part of this extension.

## Verification and acceptance

1. Regression checks: all existing catalog, client, regex, CLI and safety checks continue passing. Update only obsolete hosted-auth expectations to the new deliberate contract; do not remove protections or weaken unrelated tests.
2. Mock OIDC issuer/JWKS/token endpoint tests: valid sign-in; wrong issuer/audience/signature/nonce/state; expired tokens; callback replay and login CSRF; missing admission claims; Google hosted-domain and Entra tenant policies; identity collision on same email/different subject; no dynamic untrusted issuer.
3. Workerd D1/KV tests: credential encryption and authenticated decryption; wrong account/version/key/corrupt ciphertext failures; no plaintext retained; key validation failure preserves previous value; atomic state/session transitions; user A cannot read/change/revoke B's key or clients.
4. OAuth end-to-end tests using the real provider and a local fake OIDC issuer: client discovery, sign-in, key onboarding, escaped consent/deny, PKCE exchange, read and write scopes, refresh/revoke, wrong resource, direct write attempts with read-only grants, credential-version invalidation, and two-user concurrent isolation. No real Capy calls or paid work in tests.
5. Look at the rendered browser onboarding/account/consent flow and exercise it end-to-end locally. Publish only sanitized fake-identity screenshots to the PR and attach the same proof in the conversation. No screenshots of actual credentials or a real authorization code/cookie.
6. Run typechecks, deterministic generation, complete Node/workerd suites, migrations against a local database, production CLI build/package inspection, Worker dry-run and dependency audit. CI has no production credentials and must exercise hosted behavior, not merely bundle it.
7. Independent per-task review and a fresh final security/whole-branch review are required, following Erin's subagent-driven execution preference. Inspect the final diff and update PR #1 if it remains open; never push to a closed/merged PR. Do not merge without explicit approval.
8. A local fake-OIDC flow proves application behavior, not a live Google/Entra integration or deployed team service. Report precisely which real sign-in, deployment, storage and remote-client checks ran, and request only the access/configuration actually needed to finish an approved deployment.

## Non-goals and builder decisions

No shared team Capy key, upstream Capy OAuth, automatic key minting, multiple keys per account, issuer switching/account linking, arbitrary provider URLs per user, per-user tool customization beyond OAuth scopes, cross-request MCP cancellation registry, custom password database, billing portal, or public multi-tenant hosted SaaS.

The builder chooses file layout, supported published library versions, exact browser routes, migration schema, session/state/token TTLs and bounds, and rate-limit configuration. Those choices must implement the observable behaviors and security boundaries above. The main trust model, per-user key ownership, fail-closed admission and scope enforcement are not left optional.

## Sources checked

- Capy's local API authentication reference: API-key-only upstream authentication, explicit principal authority, no API key minting endpoint, no per-key scopes.
- Cloudflare Workers OAuth Provider README and authorization/securing-MCP guides, read 2026-11-23: one-Worker `OAuthProvider` remains supported; OAuth state uses KV; application owns OIDC login, consent and fine-grained scope enforcement.
- `openid-client` official documentation through Context7: Workers-compatible standards-based discovery, authorization code/PKCE/state/nonce and ID-token validation. Published versions observed before planning: Workers OAuth Provider 1.3.0 and openid-client 6.9.1; installed source/types must confirm the chosen integration.
