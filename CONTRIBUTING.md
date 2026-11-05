# Contributing

This repository is private and its package is unpublished. MLH must choose a license before open-source publication or public distribution; do not add a license on MLH's behalf.

## Development

Use Node.js >=22 and the committed npm lockfile:

```sh
npm ci
npm run generate:check
npm run typecheck
npm test
npm run worker:check
npm pack --dry-run
git diff --check
```

`npm test` builds the production STDIO CLI and runs all Node and workerd tests. Use `npm run test:worker` for a focused Worker rerun. The Worker suite uses the supported `@cloudflare/vitest-plugin` 1.5.1 with Vitest 4.1.12, not the deprecated Workers pool. Tests mock upstream Capy responses and use fake credentials; don't add real API keys or billable integration calls to CI. Wrangler's missing-required-secret warning occurs before fake Miniflare bindings merge; preserve production requirements and investigate new warnings separately.

Write a failing regression before changing functional code, then run the relevant checks after the fix. Keep the shared catalog/client/server independent of transport state. Never add runtime schema compilation/eval to Workers, automatic mutation retries, payload logging, credential passthrough, or permissive Origin handling. Add tests for schema changes, group fail-closed behavior, safe error handling, and runtime bounds as applicable.

`npm run worker:check` only bundles to ignored `dist/worker`; it does not deploy. `npm pack --dry-run` should list the executable `dist/stdio.js`, `package.json`, and npm-included documentation, not secret files or Worker build artifacts. Inspect every listed file and the generated CLI bundle when changing packaging. `private: true` must remain until publication and licensing are explicitly authorized.

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

When Worker bindings/configuration change, run `npm run types:worker`, inspect `worker-configuration.d.ts`, and verify with `npx wrangler types --strict-vars=false --check`. Wrangler currently emits trailing whitespace in parts of its generated file; normalize whitespace if needed before the final diff check. Keep real secrets out of type-generation input and committed files.

## Change review

Describe behavior, tests actually run, known warnings, and any unverified live integrations. Update operational/security guidance when configuration or authority changes. Do not deploy, publish, or include real credentials as part of a contribution check. Follow [SECURITY.md](SECURITY.md) for sensitive reports; public issues and pull requests are not secret storage.
