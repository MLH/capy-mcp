# Contributing

This repository is private and its package is unpublished. MLH must choose a license before open-source publication or public distribution; do not add a license on MLH's behalf.

## Development

Use Node.js 22 or 24, the committed npm lockfile, OpenSSL, tar, and local Chromium/Chrome. The browser check defaults to `chromium` on PATH; set `CHROMIUM_BIN` for a different executable.

```sh
npm ci
npm run check:provider
npm run generate:check
npm run types:worker:check
npm run typecheck
npm test
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/task5-check
npx wrangler d1 migrations list DB --local --persist-to .wrangler/task5-check
npm run test:browser-consent
npm pack --dry-run
npm run check:artifacts
npm audit --audit-level=high
git diff --check
```

`npm test` builds the production STDIO CLI, exercises the executable as a child process, and runs all Node and workerd tests. Use `npm run test:worker` for a focused Worker rerun. The Worker suite uses `@cloudflare/vitest-plugin` 1.8.3, Vitest 4.1.12 and Wrangler 4.163.0. Wrangler's missing-required-secret warning occurs before fake Miniflare bindings merge; `openid-client` and `oauth4webapi` ship sourcemaps with absent sources. Leave these warnings visible, preserve required production secrets, and investigate new warnings separately.

Write a failing regression before changing functional code, then run the relevant checks after the fix. Keep the shared catalog/client/server independent of transport state. Never add runtime schema compilation/eval to Workers, automatic mutation retries, payload logging, credential passthrough, or permissive Origin handling. Add tests for schema changes, group fail-closed behavior, safe error handling, and runtime bounds as applicable.

`npm run test:browser-consent` first dry-runs the Worker bundle, then launches it with local workerd, D1 and KV and drives an isolated Chromium profile. It exercises real form navigation and cookies, signed fake OIDC for admission and denial, the fake Capy key connection, consent, code exchange, an MCP read, revocation and the localhost/IPv6 callback handoffs. The fixture intercepts Worker outbound requests instead of contacting any real service; don't add real keys, accounts or billable calls. No production bypass is needed. To recapture the [reviewed screenshots](docs/images/hosted-oidc), run `HOSTED_SCREENSHOT_DIR=docs/images/hosted-oidc npm run test:browser-consent` and visually review the seven PNGs before committing. Captures exclude browser chrome, leave key inputs blank, and redact even the unsigned fixture callback URL in the consent image.

`npm run worker:check` only bundles to ignored `dist/worker`; it does not deploy. `npm pack --dry-run` lists intended package contents; `npm run check:artifacts` builds a temporary tarball, verifies its exact contents, and initializes the unpacked STDIO executable without installing dependencies. It also checks emitted Worker files and source maps for fixture and local secret material. `private: true` must remain until publication and licensing are explicitly authorized.

## Pinned API contract

`api/openapi.json` is the reviewed source of truth, with retrieval metadata and SHA-256 in `api/source.json`. Runtime never fetches the remote contract. To deliberately refresh from the official upstream source:

```sh
npm run api:refresh
npm run generate
npm run generate:check
npm run typecheck
npm test
```

Refresh is a network operation. Inspect both the upstream contract diff and all generated artifacts in `src/generated/`; do not hand-edit generated schemas or validators. Generation must reject unsupported schema/serialization features, unresolved references, and naming collisions instead of silently losing validation. Account for every operation and update coverage docs/tests if the approved scope changes. `npm run generate` alone regenerates from the pinned local snapshot.

Path parameter schemas must accept only strings, including through references and unions; non-string path shapes fail generation rather than advertising values the request builder rejects. Query scalar/array support is unchanged. Every copied schema preserves `__proto__` property constraints through equivalent pattern validation, including nested/referenced bodies and existing pattern constraints. Check both advertised schemas and standalone validators when changing this normalization.

When Worker bindings/configuration change, run `npm run types:worker`, inspect `worker-configuration.d.ts`, and verify with `npm run types:worker:check`. Wrangler currently emits trailing whitespace in parts of its generated file; normalize whitespace if needed before the final diff check. Keep real secrets out of type-generation input and committed files.

## Change review

Describe behavior, tests actually run, known warnings, and any unverified live integrations. Update operational/security guidance when configuration or authority changes. Do not deploy, publish, or include real credentials as part of a contribution check. Follow [SECURITY.md](SECURITY.md) for sensitive reports; public issues and pull requests are not secret storage.
