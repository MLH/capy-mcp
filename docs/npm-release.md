# npm releases

The approved npm package is `@mlhacks/capy-mcp`, publicly distributed under the MIT license. The executable remains `capy-mcp`, supports Node 22+, and takes each user's `CAPY_API_KEY` from their process environment. This release process does not deploy or modify the hosted Worker.

## Release boundary

GitHub Actions verifies the release, then stages the exact tested tarball through npm trusted publishing (OIDC). A maintainer inspects the staged version and approves it with npm 2FA. Neither merging a PR nor staging a package makes the real version live. Do not replace `npm stage publish` with direct `npm publish`, give the trusted publisher direct-publish/dist-tag permission, or add a long-lived npm token.

The manually dispatched `stage-npm.yml` workflow runs only on `main`, on GitHub-hosted runners. Its verification job has no OIDC permission. A separate staging job receives the verified tarball through an immutable workflow artifact and has `id-token: write`; it does not install or run the project's development dependencies. Both jobs use Node 24.22.1 and npm 11.19.1, meeting npm staging's Node 22.14+/npm 11.15+ minimum. Release builds do not use dependency caches.

The CLI is rebuilt by `prepack`. Its tarball contains only the executable, manifest, README, MIT license and bundled dependency license notices. The artifact check starts it extracted, installed offline, and through fresh-cache offline `npx` using a fixture key without contacting Capy. Development scripts, Worker code, deployment configuration, tests and credentials are excluded. npm registry installations do not need build tools or hosted credentials.

## One-time npm setup

An npm maintainer with access to `@mlhacks` and account 2FA must create the package before its trusted publisher can be configured. Use a separate empty directory, not the application checkout. Create a manifest named `@mlhacks/capy-mcp`, version `0.0.0-bootstrap.0`, license `MIT`, with public npm registry access, then authenticate locally and run `npm stage publish --access public --tag bootstrap` using npm 11.15+. The explicit tag is required for this prerelease version.

For a new package, npm makes a public `0.0.0-stage` placeholder while the empty bootstrap remains staged. **Do not approve the bootstrap.** Save its stage ID, configure trust, then reject that empty stage with `npm stage reject <stage-id>` and 2FA. Do not reuse the bootstrap version for a real release.

Configure the package's GitHub trusted publisher on npm:

| Field | Value |
| --- | --- |
| Organization | `MLH` |
| Repository | `capy-mcp` |
| Workflow filename | `stage-npm.yml` |
| Environment | Leave blank. |
| Allowed actions | Stage publishing only; direct publishing and dist-tag management disabled. |

The workflow must exist on the repository's default branch first. npm requires a new trust configuration to complete its first successful publish within two days or be recreated. Do not claim the trust is working until an actual GitHub staging run succeeds. Keep account 2FA enabled and restrict or revoke obsolete publishing tokens.

The repository must be public for the workflow's required provenance generation. Trusted publishing authenticates CI; provenance links the artifact to its source and workflow, not to a security audit. No visibility change is part of running this workflow.

## Stage and approve a release

1. Update the package and lockfile version in a reviewed PR. Never reuse a version that is published or already staged. Merge only with a maintainer's approval.
2. In GitHub Actions, manually run **Stage npm release** on `main`. The workflow reruns the repository checks, verifies packaging, and uses `npm stage publish` with provenance. It does not approve the stage or move dist-tags directly. A rerun after successful staging will fail on the existing version; inspect the queue instead of retrying blindly.
3. Inspect the staged version on npm or with `npm stage list @mlhacks/capy-mcp`, `npm stage view <stage-id>` and `npm stage download <stage-id>`. Check name, version, dist-tag, contents, integrity and provenance against the intended workflow run.
4. Approve that specific version on npm or with `npm stage approve <stage-id>`, completing 2FA. This is the operation that makes the version publicly installable. If it is wrong, reject it instead; nothing in GitHub automatically approves it.
5. Verify the live registry metadata and run the published package through an MCP client with its key supplied securely. For the first release, the command is `npx --yes @mlhacks/capy-mcp@0.1.0`. Local tarball tests do not prove a registry release or a live Capy call.

After publication, package bytes cannot simply be rolled back. Prefer a corrected new version and deliberate deprecation of a bad release; a code revert does not remove an npm version or undo upstream work.

References: [staged publishing](https://docs.npmjs.com/staged-publishing/) and [trusted publishing](https://docs.npmjs.com/trusted-publishers/).
