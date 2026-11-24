# Combined hosted OIDC final-review fix

Base: `7735ac53ff100959f527d0804692ea1b09daf01f`. Implementation: `387c519d5d87e2a97cfa470c4aec9f29d55b3948`. This is the implementer's local verification, **not independent approval or a passing GitHub check**. No push, PR change, deployment, package publication, live credentials, or remote resource operation.

## Findings, reproduction and verification

Commands below run in the repository root. The Worker tests execute the actual hosted handlers against local workerd and migrated D1/KV. Issuers, signing keys, OAuth clients, upstream responses and credentials are test fixtures. For the RED commands the new regression was present but the corresponding fix was not.

**I1 — what the form displayed is what the write compares.** `src/hosted/{pages,account,store}.ts` renders the connection status and generation from one primary read. Ordinary connect, replace and remove-confirmation forms submit that generation. The handler rejects missing, repeated, noncanonical or unsafe-integer inputs before validation; an obsolete value returns 409. Replacement uses the submitted generation in the existing final upsert CAS; deletion compares it in the version-increment and physical-delete statements of one transaction. The onboarding flow retains its independent stored transaction/session version. Grant, owner and CSRF selection did not move to the form.

- RED: `npm run test:worker -- tests/hosted/account.test.ts -t 'rendered generations|noncanonical generation'`: 8 failed; the hidden value was missing and malformed generations went on to validation instead of returning 400.
- GREEN: `npm run test:worker -- tests/hosted/account.test.ts`: 34 passed. Two ordinary pages cannot both connect; resubmitting a remove confirmation after removing/reconnecting returns 409 and preserves the new connection. The store regression also submits the obsolete generation *directly* to the SQL mutation after reconnecting. The existing delayed-validation race still checks the winning envelope/grant. Updated ordinary form fixtures in `account.test.ts`, `oauth.test.ts`, `mcp.test.ts` and the store contract in `store.test.ts`; no generation field substitutes for an OAuth onboarding transaction.

**I2 — denied people can end their own session.** `src/worker.ts` directly dispatches the exact canonical account GET and logout endpoint. The ordinary account read still requires full configuration and current admission. Its fallback in `hosted/{account,browser,pages}.ts` exposes only a logout form, and only with the current browser's unexpired session and verified CSRF cookie. It reads no vault contents and returns no account/grant context. The denied form uses strict-origin so Chromium sends a usable Origin on its same-origin POST; no-store, self-only form action and anti-framing remain. The existing logout handler enforces HTTPS canonical URL, method, exact Origin, both rate limiters, body bounds and session-bound form CSRF. No key, consent or grant mutation uses this exception.

- RED: `npm run test:worker -- tests/hosted/oauth.test.ts -t 'fresh .* account page'`: 2 failed (no logout form on withdrawal; 503 instead of a usable denial page without policy).
- GREEN: the same two composed-Worker cases pass. Changing policy, or removing policy together with vault/IdP configuration, still permits rendering and using only the own-session form. Wrong CSRF fails; restoring configuration and replaying the *original* cookies after logout gives 401. The final signed Chromium flow also withdraws a previously admitted subject's claim, opens a fresh denied account document, submits its real form, and verifies the session row is gone. The initial denied-subject and admitted flows remain.

**I3 — client assertion keys require direct HTTPS 200.** `scripts/prepare-oauth-provider.mjs` adds the approved two unique substitutions in the pinned distribution's remote JWKS fetch: manual redirects and exact 200. The validated HTTPS URI, WebCrypto verification, body-size and time limits, provider caches, global public-fetch restriction, version/JS/declaration hashes and MIT notice remain intact. No general network wrapper or unpatched fallback. `docs/hosted-oauth-provider.md` documents the change.

- RED: `npm run test:worker -- tests/hosted/oauth.test.ts -t 'authenticates a signed client'`: 3 failed (no explicit manual policy; 206 accepted instead of invalid_client).
- GREEN: same command: 3 passed. An actual registered-metadata client and a fresh synthetic RSA key complete signed `private_key_jwt` code exchange on direct 200; a redirect response or parseable 206 returns invalid_client without an access token. The test observes the *key-source* request's redirect mode, separate from the metadata request. `npm run prepare && npm run check:provider` passed, also through fresh locked installs.

**I4 — finite housekeeping, outside the authority acknowledgement.** Migration `0005_hosted_maintenance.sql` indexes login/session expiry, browser session binding, and per-owner revoked and stale-generation/epoch queues. In `store.ts`, login/session insertion removes at most 32 expired rows from its own table. SQL expiry and browser-bound one-shot consumption still apply even if no sweep ran. Grant selection uses three disjoint indexed ranges and one total LIMIT 8. `account.ts` acknowledges the committed D1 change without awaiting provider cleanup; `oauth.ts` ties the work to `ctx.waitUntil`. The provider's supported revoke helper receives a cleanup-only KV adapter. It does not parse a KV key. Across all selected grants it allows at most 48 list/delete operations, with list pages capped at eight, and starts no more KV work after five seconds. Unfinished grants remain eligible on later account mutations. Completed provider work alone changes the D1 cleanup marker.

- RED: `npm run test:worker -- tests/hosted/{mcp,store}.test.ts -t 'reclaims one|cleanup budget|before slow'`: 3 failed (40 expired rows remained instead of 8; one pass processed all 12 grants instead of 8; no response before a slow cleanup completed).
- GREEN: same selection: 3 passed; a later pass drains the excess, live sessions/logins survive, and stale authority is rejected while cleanup stalls/fails. `-t 'single large grant'` adds a paged 64-entry fixture and a partial-failure case: an interim implementation allowed the execution context to finish while a sibling delete was pending; tracking the bounded set of started deletes fixed it (2 passed). The existing real-provider KV removal test still checks actual deletion, now after the test execution context drains. The separate timing test observes the response *before* draining it.
- Index proof: applied all migrations to SQLite and ran `EXPLAIN QUERY PLAN` on the actual cleanup SELECT and transaction onboarding SELECT. An intermediate owner-only index used `(account_id=?)` but could still scan that owner's live grants. Final grant searches use `app_grants_cleanup_revoked (account_id=?)`, `app_grants_cleanup_generation (account_id=? AND credential_version<?)`, and `(account_id=? AND credential_version=? AND authorization_epoch<?)`. The expiry lookups use their covering `expires_at<?` indexes, and onboarding uses `browser_sessions_binding (csrf_hash=? AND account_id=? AND expires_at>?)`. Both final matrix legs separately applied the five migrations in **local Wrangler D1** and listed none pending.

**I5 — validated failures complete privately; unknown destinations never navigate.** `hosted/oauth.ts` rejects ambiguous parameters locally, then uses the provider's parsed request or its `AuthorizationError` *with* safe redirect context. It builds the fixed protocol code, state and issuer with the library's `authorizationErrorRedirect`, without echoing arbitrary upstream descriptions or rebuilding the destination from query input. The private same-origin completion document carries no-store/no-referrer and no Location. Unknown client or mismatched/untrusted redirect remains local.

- RED: `npm run test:worker -- tests/hosted/oauth.test.ts -t 'rejects modified consent'`: missing completion navigation.
- GREEN: the same test verifies fixed invalid_scope, invalid_request, invalid_target and unsupported_response_type callbacks for a known client, exact state/issuer and the private headers/body. Unknown client and mismatched redirect return 400 without Refresh or Location. Modified consent form fields, wrong verifier and wrong exchange resource remain rejected.

**I6 — packed STDIO installs independently of Worker libraries.** `package.json` and lockfile classify the four already-bundled/build inputs as development dependencies. The private tarball has no *installation* dependency edges; the source manifest still names the pinned libraries for reproducible builds. No versions, package records or integrity values changed (206 non-root lock records compared). `scripts/check-artifacts.mjs` tests the extracted executable as before, then performs a real npm install in a new consumer with a new, empty cache, inspects `npm ls --omit=dev --all`, and initializes the installed bin. No publication.

- RED: `npm run check:artifacts`: offline npm install failed with ENOTCACHED resolving workers-oauth-provider.
- GREEN: same command passed, with only README, manifest and executable in the tarball, no runtime dependency edges and successful MCP initialize in both environments. Both locked installs prepared the provider, then built the CLI and Worker successfully.

**I7 — bounded cold Chromium readiness, prompt safe faults.** `tests/hosted/fixtures/browser-lifecycle.ts` gives creation and attachment a single 30-second cold-start budget, then five seconds per established command. Child process failure/exit, broken or closed pipes, invalid frames and CDP rejections reject outstanding commands without copying URLs, frames, arguments, stderr or raw child errors. Up to 100 ms of fault coalescing lets an accompanying child exit report its code rather than racing an EOF. Timers and pending commands clear on failure. The existing TERM/KILL teardown (1.5 s each), CI's 3-minute browser step, and individual browser assertions are unchanged; there are no assertion retries.

- Original GitHub Node 22 job 138201204832 establishes only a missed Target.createTarget deadline, not why it happened. Local pre-fix control: point `CHROMIUM_BIN` at an executable shell file with `sleep 6; exec chromium "$@"` and run `npm run test:browser-consent`: `Browser timed out: Target.createTarget`. Separate executable children with `exit 7` or `exec 4>&-; sleep 20` produced a raw pipe failure or the misleading target timeout respectively. These are synthetic controls, **not** a reconstruction of the GitHub host.
- GREEN: the six-second wrapper completed the entire signed production-bundle flow on Node 22. Supported standalone boundary repro: `npx vitest run tests/browser-lifecycle.test.ts` on either supported Node. Actual child fixtures cover delayed 5.3-second target success, a subsequent unanswered command hitting its five-second limit, exit 7, a live child closing its output pipe, malformed frame text and all four prior teardown cases (8 passed). A strengthened exit-vs-pipe assertion initially received “Browser debugging pipe failed” for exit 7; after fault coalescing, the exit case requires precisely “Browser exited: 7” and the live EOF case requires a pipe diagnostic. The final complete matrix was rerun on both versions.

## Nonblocking review items

- Public path errors: `worker.ts` emits fixed OAuth JSON/no-store, reflected Origin with Vary and no credentialed CORS only for public token/registration failures. No change to the account/consent/MCP CORS policy. `npm run test:worker -- tests/hosted/oauth.test.ts -t 'only public'` went from 2 failed (missing Allow-Origin) to 2 passed, including size, limiter, configuration, target and private-route checks.
- Browser proof: `browser-consent.mjs` now rejects a top-level JSON-RPC error, rejects tool errors and checks the expected structured projects payload. Every callback-path arrival contributes to a sticky cookie/referrer flag *before* state/decision matching, with a separate final arrival count after receiver shutdown. Negative controls in disposable copies of the harness showed the old assertions accepted both a missing-result protocol error and an unmatched callback with a fixture referrer. Final controls failed as intended: “MCP returned a JSON-RPC error” and “Client callback received referrer or cookies.” No raw callback URL/header was printed.
- Operator guidance: valid master-key ID example/alphabet/length, root-only ignored secret filename, actual protected external secret-manager filepath, and bounded known-marker wording in the deployment guide, CONTRIBUTING and artifact output. Denied-page retry copy no longer promises identity selection. The discovery client-auth adapter now returns the delegated authenticator's result.
- Existing missing-required-secrets warnings (before test binding merge), missing upstream source-map files, expected fixed CIMD warning and npm install-script notices remain visible. No new dependency pins, warning suppression, environment secrets or observability changes. The dated no-native-tracing exception remains in force.

## Final verification and media

Ran these clean local matrix legs with deployment/credential variables unset, Wrangler metrics disabled, Node 22.23.5 and Node 24.22.1, npm 11.19.1, and Chrome 157.0.8103.78:

```sh
npm ci
npm run check:provider
npm run generate:check
npm run types:worker:check
npm run typecheck
npm test
db=$(mktemp -d)
npx wrangler d1 migrations apply DB --local --persist-to "$db"
npx wrangler d1 migrations list DB --local --persist-to "$db"
npm run test:browser-consent
npm pack --dry-run
npm run check:artifacts
npm audit --audit-level=high
git diff --check
```

Each leg: 102 tools and validators, six documented exclusions; both TS projects and binding drift passed; **172 Node + 263 workerd tests passed**; five local migrations, none pending; dry run 1914.15 KiB / 286.73 KiB gzip. Both signed browser flows and real offline npm installs passed; audit reported 0 vulnerabilities. Both browser flows were additionally exercised against the final source after preserving the original rejected-subject fixture's otherwise-valid domain. Scratch logs for this checkout are under `~/.capy/work/final-fix/`; use the assertions above rather than sharing raw test diagnostics.

Recaptured all seven original paths in `docs/images/hosted-oidc/` with the production-bundle fixture. Inspected the rendered images and decoded all seven PNGs (no metadata keys). Password fields are blank; the consent destination is redacted; no browser chrome, headers, callback parameters or credential values appear. `02-sign-in-error.png` now shows the fresh signed-in denial and its logout form; `05-account.png` changed with the fixture grant timestamp. The other five are byte-identical to the previous branch images. **Controller: re-upload the final media before updating the PR proof.** No media were published from this task.

## Residual boundaries and review handoff

- Necessary gate: one independent scoped re-review of `7735ac5..387c519`, then GitHub's Node 22/24 checks on the published head. Local passes do not change the old CI result. This report does not claim merge readiness.
- KV cleanup is best effort and opportunistic: failed/over-budget work can remain until another account mutation or provider expiry. Five seconds bounds starting new KV operations; it does not abort KV I/O already issued. Those promises stay attached to the Worker execution context (platform background lifetime), not the response. Primary D1 alone enforces new-call revocation. This is not a scheduled global purge or a claim of linearizable KV.
- The third-party patch and the cleanup-only list/delete adapter are pinned-version maintenance obligations. Unknown methods fail closed. No verification of live IdP, external clients, remote D1/KV, Capy, telemetry, restore, billing, or deployment. No new architectural ruling beyond the approved direct-key-source correction.
