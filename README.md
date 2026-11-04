# Capy MCP

Expose 102 named Capy API tools to Hermes and other MCP clients through local STDIO or a self-hosted Cloudflare Worker. Both transports use the same generated schemas, validation, group filtering, and bounded API client. The upstream origin is fixed to `https://api.capy.ai`.

This package is **private and unpublished**. Run the built local file; there is no published npm package to install with `npx`. MLH must choose a license before open-source publication or public distribution. No license is granted by this repository's current packaging.

## Local installation and STDIO

Use Node.js 22 or newer and npm. From this checkout:

```sh
npm ci
npm run build
```

Set `CAPY_API_KEY` in the process environment using your secret manager, then start the built server:

```sh
node /absolute/path/to/capy-mcp/dist/stdio.js
```

STDIO exchanges MCP protocol messages on stdin/stdout, not an interactive prompt. Startup failures go to stderr without credentials. `SIGINT` and `SIGTERM` close the server. It needs no `MCP_AUTH_TOKEN`.

## Authority and configuration

A Capy key acts as its configured human or service-user principal in one organization, with that principal's live permissions and project access. It does not grant extra authority or per-key scopes. Obtain keys through Capy's **Settings → API**. For unattended use, prefer a service user with the narrowest role/project access and a monthly spend cap. See [Capy authentication](https://docs.capy.ai/api-reference/authentication).

| Variable | STDIO | Worker | Meaning |
| --- | --- | --- | --- |
| `CAPY_API_KEY` | Required environment secret | Required Worker secret | Upstream Capy bearer credential. |
| `CAPY_TOOL_GROUPS` | Optional environment value | Wrangler `vars` | Comma-separated, case-sensitive group allowlist. Unset enables all 102 tools; empty or unknown groups fail closed. |
| `MCP_AUTH_TOKEN` | Not used | Required Worker secret | Separate bearer credential for MCP clients; must differ from the Capy key. |
| `MCP_ALLOWED_ORIGINS` | Not used | Wrangler `vars` | Comma-separated exact HTTP(S) origins, with no paths, trailing slashes, or whitespace. Empty permits no browser origins. |

Both secrets must be nonempty printable ASCII without spaces. Use a long cryptographically random MCP token, generated independently from the Capy key, and store it securely. Clients cannot pass a Capy key or arbitrary request headers through tool arguments. The incoming MCP bearer is never used as the upstream API key.

Supported groups are:

```text
attachments,automations,captains,files,folders,issues,messages,projects,reviewFilters,reviewRules,reviews,subagents,threads,usage,users
```

The checked-in Worker configuration explicitly enables all these groups. For a Hermes-focused deployment, replace its `CAPY_TOOL_GROUPS` value in `wrangler.jsonc` with:

```text
captains,issues,messages,threads,projects,users
```

For STDIO, set that same value in the environment. Filtering applies to both discovery and direct calls, but isn't a substitute for principal permissions. **The all-groups default includes sensitive mutations, including project environment-variable writes.** Even the Hermes-focused example includes `projects`, so it is not read-only. Tool annotations are guidance, not authorization or a spending safeguard.

## Worker development and deployment

The Worker serves only `/mcp`, using stateless Streamable HTTP with finite JSON responses and no persistent sessions. Authenticated `POST` is supported; after authentication and Origin checks, `GET`, `HEAD`, and `DELETE` return 405. Requests without an `Origin` header can proceed after authentication. A request with an Origin must match `MCP_ALLOWED_ORIGINS` exactly; no permissive CORS is supplied.

For local development, put `CAPY_API_KEY` and `MCP_AUTH_TOKEN` in a private `.dev.vars` file beside `wrangler.jsonc`, using dotenv syntax. These files are ignored by Git. Do not put secrets in Wrangler `vars`, source files, shell history, or example configuration. Local calls still contact the real Capy API and can incur costs.

```sh
npx wrangler dev --local --ip 127.0.0.1 --port 8787
```

The local endpoint is `http://127.0.0.1:8787/mcp`. Validate bundling without uploading or deploying:

```sh
npm run worker:check
```

The dry-run writes to ignored `dist/worker`. It needs no Cloudflare account or deployment credentials and does not prove secrets are provisioned or a deployed endpoint works.

### Authorized deployment only

The following commands change Cloudflare resources. They are instructions for an operator, not part of tests or CI. First choose the account and Worker name in `wrangler.jsonc`, authenticate Wrangler, review principal/group access, and arrange secure secret storage.

For the first deployment, create a permission-restricted, Git-ignored `.env.production` containing both required secrets, then upload code and secrets together:

```sh
npx wrangler login
npx wrangler deploy --secrets-file .env.production
```

Keep that file out of artifacts and backups that aren't approved for secrets; remove it securely when no longer needed. For later interactive secret rotation on the existing Worker, Wrangler prompts for values:

```sh
npx wrangler secret put CAPY_API_KEY
npx wrangler secret put MCP_AUTH_TOKEN
```

**Each `secret put` immediately creates and deploys a Worker version.** Coordinate MCP token rotation with clients. Both secrets remain required in the production config. For subsequent code deployment with already-provisioned secrets:

```sh
npx wrangler deploy
```

`workers_dev: true` makes the deployed Worker network-reachable at the workers.dev URL printed by Wrangler; append `/mcp`. Access is token-protected, not a private network. `preview_urls: false` disables preview URLs. Never remove authentication to make a client connect. Logs and traces are enabled, automatic invocation logs are disabled, and URL query strings are redacted. The application does not log payloads or credentials; review any additional platform logging before enabling it.

## Hermes setup

These YAML entries follow the [current official Hermes MCP config reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference), read on 2026-11-04. Add **one** entry under `mcp_servers` in your Hermes `config.yaml`. Put secrets in the active Hermes profile's secret scope (normally `~/.hermes/.env`) or process environment; `${env:...}` references keep them out of YAML. Configuration syntax was checked against the docs, but no live Hermes session has been verified.

### Local STDIO

Build first and replace the absolute path. Hermes launches Node itself:

```yaml
mcp_servers:
  capy:
    command: "node"
    args: ["/absolute/path/to/capy-mcp/dist/stdio.js"]
    env:
      CAPY_API_KEY: "${env:CAPY_API_KEY}"
      CAPY_TOOL_GROUPS: "captains,issues,messages,threads,projects,users"
    timeout: 60
    trust: untrusted
```

### Remote Worker

Replace the example host with the authorized deployment's host. Hermes uses Streamable HTTP by default; don't set `transport: sse` or `auth: oauth` for this server.

```yaml
mcp_servers:
  capy:
    url: "https://capy-mcp.example.workers.dev/mcp"
    headers:
      Authorization: "Bearer ${env:MCP_AUTH_TOKEN}"
    skip_preflight: true
    timeout: 60
    trust: untrusted
```

`skip_preflight` bypasses Hermes' HEAD/GET content-type probe because this POST-only endpoint returns a plain-text 405 for those methods. It does not bypass TLS, bearer authentication, or Origin validation. Do not send `CAPY_API_KEY` to the MCP endpoint: it lives only on the Worker. Hermes' `trust: untrusted` requests approval for write-capable tools under its normal approval policy; it is not a server-side permission boundary. The server implements tools only, not MCP resources or prompts.

## Tool call examples

Tool names derive from operation IDs (`issues.createState` → `capy_issues_create_state`). Arguments retain the generated `path`, `query`, and `body` objects; do not flatten fields. The examples below show MCP `tools/call` parameters, not raw Capy requests. Substitute IDs from preceding results. Mutating examples can start billable work or change organization data; approve them deliberately.

### Discover a Captain and message its thread

List Captains, choose an item by name/description, and use its `id` (the Captain's thread ID) for message tools:

```json
{"name":"capy_captains_list","arguments":{}}
```

```json
{"name":"capy_captains_get","arguments":{"path":{"captainId":"<captain-thread-id>"}}}
```

```json
{"name":"capy_messages_send","arguments":{"path":{"threadId":"<captain-thread-id>"},"body":{"text":"Investigate the failing build and report findings before making changes.","delivery":"queue","clientKey":"build-investigation-001"}}}
```

Reuse `clientKey` only when retrying that same logical send to the same thread. `queue` waits for current work; `steer` lands at the next step; the default `interrupt` interrupts current work. Read a bounded page of results:

```json
{"name":"capy_messages_list","arguments":{"path":{"threadId":"<captain-thread-id>"},"query":{"limit":20}}}
```

To continue forward, set `query.after` to the returned `cursor`; to read older entries, use `query.before` with `beforeCursor`. Those cursors must be the returned 26-character event IDs, not an arbitrary timestamp.

### Look up issue states/labels and create an issue

These lookups take no project argument. Use IDs from their responses, and a project ID returned by the project list:

```json
{"name":"capy_projects_list","arguments":{}}
```

```json
{"name":"capy_issues_states","arguments":{}}
```

```json
{"name":"capy_issues_labels","arguments":{}}
```

```json
{"name":"capy_issues_create","arguments":{"body":{"projectId":"<project-id>","title":"Investigate the failing build","description":"Capture a reproducible failure and propose a fix.","stateId":"<state-id>","labelIds":["<label-id>"],"priority":"normal"}}}
```

Omit `stateId` to use the organization's default, or omit `labelIds` when no label applies. Later issue tools use the returned issue code (for example `CAP-12`) under `path.code`, not the issue's internal ID. Issue creation has no `requestId` field: don't invent one or blindly repeat a create after an uncertain outcome. Where a generated creation schema **does** require `requestId` (such as Captain or thread creation), mint it once and reuse it for retries; this server never generates it.

## Results, errors, and bounds

- Successful upstream JSON is returned as structured output and JSON text. Objects are unchanged; arrays, scalars, and null use `{ "result": value }` in structured output. The one declared empty HTTP 200 success, `threads.leave`, becomes null; empty successes on JSON-declaring operations remain errors.
- Pagination is manual. Cursors and pages are returned unchanged; no automatic pagination or silent truncation occurs. File/attachment tools negotiate JSON upload/download URLs; this server doesn't read your filesystem or fetch signed URLs on your behalf.
- Each upstream request has a **30-second deadline**, covering headers and body, and a **1 MiB (1,048,576 bytes) response limit**. Worker MCP POST bodies also have a **1 MiB** limit. Oversized or timed-out results fail explicitly; the server doesn't return a partial success.
- Invalid arguments, unsafe path values, and unknown/disabled tools fail as MCP protocol errors before upstream work. Capy/transport failures are `isError: true` tool results with sanitized error codes and optional `status`, allowlisted `tag`, and `retryAfterSeconds`. Raw upstream errors, echoed request data, and exception prose are not returned.
- A Capy `429` preserves safe retry guidance; wait for `retryAfterSeconds` when supplied. No automatic retries are performed, especially for mutations. After a timeout or cancellation, a mutation may already have happened upstream: check its outcome and reuse supported idempotency inputs rather than creating duplicate work. Upstream redirects are refused.

## Coverage and exclusions

The pinned [OpenAPI contract](api/openapi.json), with [source/date/SHA-256 metadata](api/source.json), contains 108 operations. The committed [catalog](src/generated/catalog.json) exposes 102 finite tools, including `threads.leave`'s declared empty success. Runtime startup never downloads a changing schema. Six operations are intentionally excluded:

| Excluded operation | Reason and alternative |
| --- | --- |
| `tasks.list` | Legacy alias; use `capy_subagents_list`. |
| `tasks.get` | Legacy alias; use `capy_subagents_get`. |
| `tasks.messages` | Legacy alias; use `capy_subagents_messages`. |
| `streams.thread` | Continuous SSE; use `capy_threads_get` and paginated `capy_messages_list`. |
| `streams.subagent` | Continuous SSE; use `capy_subagents_get` and paginated `capy_subagents_messages`. |
| `streams.task` | Legacy continuous SSE; use the corresponding subagent JSON tools. |

There is no OAuth server, multi-user credential store, legacy SSE transport, polling daemon, or arbitrary HTTP proxy.

## Checks and contributing

```sh
npm run generate:check
npm run typecheck
npm test
npm run worker:check
npm pack --dry-run
git diff --check
```

`npm test` builds the production CLI, runs Node tests, and runs the workerd suite via `npm run test:worker` (singular); there's no need to build or run Worker tests twice. CI runs these checks on Node 22 and 24 with no deployment credentials. `npm pack --dry-run` inspects the package without publishing it. Its CLI bundle includes the catalog and standalone validators; Worker bundles, local secrets, and development source aren't package artifacts.

Worker tests intentionally provide fake Miniflare secrets. Wrangler currently warns that required secrets are missing **before** the plugin merges those test bindings. That known warning does not mean authentication tests are skipped. Production secrets remain required; don't disable them or blanket-suppress warnings to silence it.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contract refresh and checks, and [SECURITY.md](SECURITY.md) for boundaries and reporting. No live Capy/Hermes session or Cloudflare deployment was verified as part of local acceptance.
