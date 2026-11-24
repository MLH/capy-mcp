# Security

## Trust boundaries

Hosted identity comes from one configured OIDC issuer and an explicit subject and/or signed-claim policy. State is browser-bound and single-use; the Worker validates S256 PKCE, nonce, and the ID-token signature. The stable account identity is issuer plus subject, not email. Account mutations require a current session, the exact deployment Origin and a session-bound CSRF value.

An admitted user supplies a Capy key for their own hosted account. It is encrypted at rest and never included in client tokens. The key can belong to a different Capy principal than the person signing in; upstream work runs with that principal's permissions. Read, explicit write and offline refresh apply per authorized client. Even read access can expose sensitive data. Enabled writes can be billable or destructive, including project environment-variable writes. Use least-privilege Capy principals, a spend cap and deliberate tool groups. Tool annotations and client approval are not server-side permission checks.

Hosted clients use OAuth bearer tokens, not the former shared `MCP_AUTH_TOKEN`. `MCP_ALLOWED_ORIGINS` is an exact Origin check, not authentication or browser CORS. Preview URLs are off. Keep HTTPS verification enabled. Local STDIO relies on operating-system process and secret-file permissions and retains its process-local `CAPY_API_KEY`.

Application authorization for each new call and refresh uses primary D1; a committed local revoke does not depend on KV propagation. It cannot undo an in-flight mutation. The Worker calls only the fixed Capy HTTPS origin and generated routes, refuses redirects, and bounds upstream time and body size. Active request cancellation stops its upstream I/O; a separate MCP notification cannot reach another request's transport. After a timeout, revoke or cancellation, verify whether a mutation succeeded before retrying.

Keep `.dev.vars*`, `.env*`, and `.secrets.production.json` out of Git and artifacts. Provision literal JSON strings as encrypted Worker secrets, not plaintext `vars`. Preserve production required-secret checks. See the [operator runbook](docs/hosted-deployment.md) for offboarding bounds, key custody, rotation and recovery.

## Observability

Keep custom Workers Logs enabled and retain only fixed, low-cardinality application diagnostics. The hosted provider patch replaces direct warning arguments that contained client URLs, grant/client IDs or raw library exception details; the provider's detailed error hook is not logged. Application errors return bounded, sanitized responses. Never send raw request/response objects, headers (especially Cookie, Set-Cookie and Authorization), form bodies, exception causes, callback URLs, or tokens to telemetry.

The checked-in Wrangler config keeps query-string redaction on and turns off invocation logs, automatic traces and Logpush. [Automatic trace attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/) include full URLs, Cache request URLs, KV keys and metadata; query removal alone does not make those fields safe. Wrangler 4.163.0 has no filter for those attributes, and native custom spans require automatic tracing. Retain aggregate platform metrics and fixed warnings instead of collecting unsafe spans. This configuration is not a guarantee for live tails, Tail Workers, access/CDN logs, custom exporters, browser tooling, or proxies. Before enabling any additional collection, require operator approval and independently verify with fake probes that secrets are excluded before persistence or delivery to any collector, and that retention and access are restricted. Verify effective settings on the actual deployment before real onboarding. Local dry runs cannot verify Cloudflare's hosted telemetry.

## Reporting

No private vulnerability-reporting channel has been verified for this repository. Do not assume GitHub private vulnerability reporting is enabled, and do not post secrets or exploit details in a public issue or pull request. Contact a known MLH repository maintainer through an already trusted channel and ask them to arrange a private reporting path before sending sensitive details. A nonsensitive issue may request a reporting contact without disclosing the vulnerability.

If a credential is exposed, revoke/rotate it promptly with its issuer and review access and billable activity. Removing it from a file or commit does not revoke it. Share only sanitized reproduction steps and logs through the agreed private channel.

## Release status

The package remains `private: true` and unpublished, without a selected license. MLH must approve a license and publication separately. Local tests and bundle checks are not a security audit or proof of live IdP, Capy, MCP client or deployed Cloudflare compatibility.
