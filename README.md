# Capy MCP

Expose 102 named Capy API tools to external MCP clients through local STDIO or a self-hosted Cloudflare Worker. Both transports use the same generated schemas, validation, group filtering, and bounded API client. The upstream origin is fixed to `https://api.capy.ai`. The server has no client-specific runtime dependency.

The Capy name and branding belong to [Scrapybara, Inc.](https://scrapybara.com/). This is an independent integration maintained by Major League Hacking PBC Inc., not an official Scrapybara product; references to Capy do not imply sponsorship or endorsement. This project's MIT license does not grant rights to Capy's name or branding.

Licensed under [MIT](LICENSE). Public npm releases use staged publishing through GitHub Actions OIDC, followed by a maintainer's npm 2FA approval. A staged version is not installable until approved; see the [release runbook](docs/npm-release.md).

## npm STDIO installation

Once version `0.1.0` has been approved on npm, use Node.js 22+ and supply your own `CAPY_API_KEY` through your MCP client's secure process environment:

```sh
npx --yes @mlhacks/capy-mcp@0.1.0
```

For MCP clients, set the command to `npx` and arguments to `["--yes", "@mlhacks/capy-mcp@0.1.0"]`. Pin an approved version rather than silently taking future releases. No global installation, build tools, Cloudflare configuration or hosted OAuth login is needed. The process uses your key's Capy permissions and the tool groups described below.

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

| Variable | Where | Meaning |
| --- | --- | --- |
| `CAPY_API_KEY` | STDIO process environment | Required upstream key for the local CLI. Hosted users submit their own key over HTTPS after signing in. |
| `CAPY_TOOL_GROUPS` | STDIO environment or Worker `vars` | Optional comma-separated, case-sensitive group allowlist. Unset enables all 102 tools; empty or unknown groups fail closed. |

Clients cannot pass a key or arbitrary request headers through tool arguments. Hosted OAuth tokens authenticate to this Worker and are never sent upstream as Capy keys. The former hosted `MCP_AUTH_TOKEN` and shared `CAPY_API_KEY` mode is removed.

Supported groups are:

```text
attachments,automations,captains,files,folders,issues,messages,projects,reviewFilters,reviewRules,reviews,subagents,threads,usage,users
```

The checked-in Worker configuration explicitly enables all these groups. For a Captain-and-issue-focused deployment, replace its `CAPY_TOOL_GROUPS` value in `wrangler.jsonc` with:

```text
captains,issues,messages,threads,projects,users
```

For STDIO, set that same value in the environment. Filtering applies to both discovery and direct calls, but isn't a substitute for principal permissions. **The all-groups default includes sensitive mutations, including project environment-variable writes.** Even the focused example includes `projects`, so it is not read-only. Tool annotations are guidance, not authorization or a spending safeguard.

## Hosted Worker

The Worker exposes a stateless Streamable HTTP MCP resource at `<PUBLIC_ORIGIN>/mcp`, OAuth discovery and client authorization, and a browser account page. There is no legacy SSE transport or persistent MCP session. MCP uses authenticated POST with finite JSON responses; after authentication and exact Origin checks, GET, HEAD, and DELETE return 405. A missing Origin is allowed for non-browser clients. An allowlisted Origin does not provide browser CORS support.

Each account signs in through the operator's configured OIDC issuer and admission policy. The Worker keeps one encrypted Capy key per account and approves each client separately. `capy:read` allows enabled GET tools; `capy:write` requires explicit approval and adds enabled mutation tools; `offline_access` gives the client refresh capability. The Capy key's principal determines actual upstream authority. In `/account`, revoke one client, disconnect all clients, replace or remove your key, or sign out. Sign-out only ends the browser session. Revocation blocks new calls without waiting for KV propagation; it cannot undo work already in flight.

Active HTTP aborts stop outstanding upstream I/O. Each request owns its MCP transport, so a separate cancellation-notification POST does not cancel another request. STDIO supports cancellation on its existing connection. An aborted mutation may already have taken effect; check its outcome before retrying.

Use the [operator runbook](docs/hosted-deployment.md) to register an OIDC app, configure admission, provision secrets and storage, and deploy to an approved target. To run a credential-free local walkthrough with a signed fake IdP, fake Capy, local D1/KV, and Chromium, see [development checks](CONTRIBUTING.md#development).

## Connect an MCP client

### Hosted Streamable HTTP with OAuth

1. In the client, add a Streamable HTTP MCP server using the operator's canonical `https://<host>/mcp` URL. Do not configure a static Authorization header or paste a Capy key into the client's server config.
2. Start OAuth in the client. It must discover the protected resource and authorization server, register a redirect via DCR or a supported Client ID Metadata Document, and use authorization-code flow with S256 PKCE and the exact MCP resource indicator. The client stores and sends the OAuth tokens, not your Capy key.
3. In your browser, sign in with the configured IdP. Check the deployment's HTTPS origin before supplying your Capy key. Inspect the requesting client and redirect destination before approving. Leave write unchecked unless you intend to delegate mutations.
4. Return to the client. Manage or revoke the grant at `https://<host>/account`. If a key is replaced, you'll need to authorize the client again.

This server implements MCP tools, not MCP resources or prompts. Local tests exercise a fixture OAuth client and fake IdP; Duet, Dot, ChatGPT, Hermes and other real hosted clients have not been verified.

### Local STDIO example: Hermes

Build first and replace the absolute path below. Configure the process environment through Hermes's active secret scope or your secret manager. This example follows the [Hermes MCP config reference](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference); no live Hermes session has been verified.

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

Keep client approvals enabled for write-capable tools. Client approvals do not replace server-side scopes or Capy permissions.

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
- A Capy `429` preserves safe retry guidance; wait for `retryAfterSeconds` when supplied. A valid `Retry-After` delay or canonical HTTP-date (IMF-fixdate, GMT) takes precedence over a numeric JSON retry field. Future dates round up to whole seconds, past dates become zero, and malformed headers fall back to the JSON field without exposing header text. No automatic retries are performed, especially for mutations. After a timeout or cancellation, a mutation may already have happened upstream: check its outcome and reuse supported idempotency inputs rather than creating duplicate work. Upstream redirects are refused.

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

There is no legacy SSE transport, polling daemon, or arbitrary HTTP proxy.

## Checks and contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete credential-free checks, fixture browser walkthrough, and contract refresh. CI runs the same checks on Node 22 and 24. See [SECURITY.md](SECURITY.md) for trust boundaries, observability, and reporting. The npm package contains only the standalone CLI, manifest, README, MIT license and bundled dependency notices; it does not contain the Worker, fixture media or secrets. Local artifact checks do not prove an approved registry release or a live Capy connection.
