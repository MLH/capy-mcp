# Security

## Trust boundaries

This is a single-principal MCP bridge. Anyone with the Worker's `MCP_AUTH_TOKEN` can exercise the enabled tools as its configured Capy principal, including billable and destructive actions that principal is allowed to perform. It is not a multi-user authorization service. Use a restricted service user, narrow project access, a spend cap, and a deliberate tool-group allowlist. Default coverage includes environment-variable writes. Group filtering and tool annotations do not replace Capy's permission checks or client approval policy.

The workers.dev endpoint is publicly network-reachable after deployment, but requires a distinct bearer token. Preview URLs are disabled. Keep HTTPS/TLS verification enabled, protect both credentials, and rotate the MCP token if its holders change. `MCP_ALLOWED_ORIGINS` is an exact-origin check, not authentication: non-browser clients can omit Origin. Browser origins are denied by default and no permissive CORS is provided. Local STDIO relies on operating-system process and secret-file permissions.

Upstream requests use only the fixed Capy HTTPS origin and generated routes. Clients cannot supply credentials or arbitrary headers through tool inputs; the MCP token is never forwarded as a Capy key. Requests have a 30-second upstream deadline, 1 MiB upstream response bound, and a Worker 1 MiB ingress bound. Redirects are rejected; invalid inputs and disabled tools fail before upstream calls. Errors expose only sanitized metadata, not raw upstream prose. Active HTTP request abort/disconnect cancels its upstream I/O, but the stateless request-local servers cannot route a separate cancellation-notification POST to another request. Neither cancellation nor a timeout undoes a mutation already accepted upstream; verify its outcome before retrying.

Never log credentials, request/message bodies, environment values, signed URLs, or upstream response bodies. Keep `.dev.vars*`, `.env*`, and `.secrets.production.json` files out of Git and build artifacts. Use the permission-restricted JSON secrets file documented in the README for first deployment so dotenv expansion or process-environment substitution cannot change the chosen values. Wrangler secrets belong in encrypted secret bindings, not plaintext `vars`. Production required-secret checks must not be relaxed to silence local test warnings. Review platform logs/traces and any proxy logging separately before operating a deployment.

## Reporting

No private vulnerability-reporting channel has been verified for this repository. Do not assume GitHub private vulnerability reporting is enabled, and do not post secrets or exploit details in a public issue or pull request. Contact a known MLH repository maintainer through an already trusted channel and ask them to arrange a private reporting path before sending sensitive details. A nonsensitive issue may request a reporting contact without disclosing the vulnerability.

If a credential is exposed, revoke/rotate it promptly with its issuer and review access and billable activity. Removing it from a file or commit does not revoke it. Share only sanitized reproduction steps and logs through the agreed private channel.

## Release status

The package remains `private: true` and unpublished, without a selected license. MLH must approve a license and publication separately. Local tests and bundle checks are not a security audit or proof of a live Capy/Hermes connection or deployed Cloudflare access controls.
