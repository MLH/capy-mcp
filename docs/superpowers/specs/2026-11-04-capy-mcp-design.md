# Capy MCP server

Status: proposed for Erin's approval. The named-tool approach and configurable API groups are agreed; the implementation details below are proposed defaults.

## Intent

Let external MCP clients, initially Erin's Hermes agent, work with Capy. Captains and issues are the main workflow, but the server should expose most of the public API rather than restrict clients to a delegation-only interface. Support self-hosting on Cloudflare Workers and local execution over STDIO, with shared behavior across both transports. Keep the repository suitable for eventual open-source publication.

## Goals and constraints

- Provide named, schema-validated tools generated from Capy's published OpenAPI contract.
- Cover Captains, issues, projects, threads, messages, subagents, files, attachments, folders, automations, reviews, review rules, review filters, usage, and users.
- Allow a deployment to expose selected API groups without maintaining a fork.
- Use one runtime-independent implementation for tool definitions, validation, request construction, and API errors.
- Keep deployment stateless: no database, Durable Objects, credential store, or background polling service.
- Never log credentials, message bodies, environment-variable values, or upstream response bodies.
- Do not expose arbitrary HTTP requests, execute client-supplied code, or automatically grant permission beyond the configured Capy principal.

## Approaches considered

1. **Named tools generated from OpenAPI, selected by Erin.** Explicit tools give clients discoverable argument schemas and make individual calls easy to inspect. The cost is a large tool list; configurable API groups address clients that need a smaller surface.
2. **Discovery and generic execution.** A small tool list reduces initial context, but clients must discover operations before calling them and receive a less explicit interface. Rejected for the first release.

TypeScript with the official MCP SDK is the builder's recommended implementation choice. The SDK provides web-standard HTTP support for Workers and a STDIO transport for Node.js.

## Coverage and contract ownership

The OpenAPI document fetched from `https://docs.capy.ai/openapi.json` on 2026-11-04 contains 108 operations. Include its 102 non-legacy JSON operations. Exclude the three legacy `tasks` aliases because the equivalent `subagents` operations are included, and exclude the three continuous SSE `streams` operations because an unbounded stream is not a finite MCP tool result. Clients can read status and page messages using the JSON tools. Document every exclusion and its alternative.

Commit a pinned copy of the upstream contract with its source, retrieval date, and digest. Generate and commit the operation catalog from that snapshot; neither startup nor deployment fetches a changing contract. Provide an explicit refresh/generation command and a drift check so API changes produce reviewable diffs. Do not hand-copy request schemas or silently ignore unsupported schema features.

Tool names derive deterministically from operation IDs: for example, `captains.list` becomes `capy_captains_list`, and `issues.createState` becomes `capy_issues_create_state`. Fail generation on name collisions. Each tool's description identifies its purpose, parameters, and notable API semantics. Enrich Captain, issue, and messaging descriptions where the contract's summary alone is insufficient: Captains use their thread ID with the message tools; issue codes and state/label IDs come from the corresponding list tools; creation request IDs must be reused for retries.

Arguments use optional or required `path`, `query`, and `body` objects according to the operation. This avoids collisions and preserves the upstream API's field names. Path and query parameters receive their declared types and requiredness; JSON bodies preserve references, unions, enums, nested validation, and additional-property constraints. Advertised schemas and runtime validation must agree. Unsupported inputs fail before any API call.

## Configuration and access

- `CAPY_API_KEY`: required upstream credential, passed through the local process environment or a Worker secret.
- `CAPY_TOOL_GROUPS`: optional comma-separated allowlist using the OpenAPI tag names. Absent means all supported groups. Empty or unknown values fail configuration instead of silently widening access. Document a Hermes-focused configuration including `captains`, `issues`, `messages`, `threads`, `projects`, and `users`.
- `MCP_AUTH_TOKEN`: required Worker-only secret, distinct from `CAPY_API_KEY`, authorizing access to that private MCP deployment.
- `MCP_ALLOWED_ORIGINS`: optional Worker-only exact-origin allowlist. Requests without an Origin header are accepted after authentication; requests carrying an Origin must match the allowlist. The default permits no browser origins.

Use the fixed HTTPS Capy API origin `https://api.capy.ai`; paths and methods come only from the pinned catalog. Clients cannot select a host or provide request headers. Encode path parameters as individual path segments and serialize query parameters according to the contract. Do not follow upstream redirects with credentials.

Hosted deployments are private and single-principal, not a public multi-user service. Anyone holding the deployment's MCP token can exercise the exposed operations as its configured Capy principal. Group filtering is enforced both in listing and execution, not merely hidden from discovery. It is not a substitute for Capy's principal permissions. Recommend a service user with restricted project access and a spend cap for unattended use. Default broad coverage includes sensitive operations such as project environment-variable writes; document that consequence clearly.

STDIO does not require the remote MCP token; operating-system process access controls credential access. It writes protocol messages only to stdout, with sanitized startup failures on stderr. Worker authentication uses a timing-safe comparison and runs before creating a server or contacting Capy. Never accept the incoming MCP token as an upstream API key.

## Runtime behavior

The shared server factory creates an MCP server with only enabled tools. STDIO connects one instance for the process lifetime and shuts down cleanly. The Worker serves `/mcp` through stateless Streamable HTTP, constructing request-local server and transport instances; use JSON responses rather than persistent MCP sessions. Unsupported routes return 404. Unsupported transport methods return the protocol-appropriate 405. Enforce Origin checks before processing authenticated MCP traffic. Do not add permissive CORS.

The API client uses bounded requests and responses, propagates cancellation, and maps non-success responses to MCP tool errors containing the HTTP status, Capy error tag, and retry guidance when supplied. Sanitize error text so keys and secret-bearing request payloads cannot leak. Transport or protocol errors remain distinct from Capy tool errors. Never blindly retry mutations; expose `429` and retry-after information to the caller. Bound upstream time and response size, and return an explicit error rather than silently truncating paginated data. The builder chooses conservative documented limits.

Return upstream JSON without inventing a second domain model, as structured MCP output plus a compatible text representation. Do not automatically exhaust pagination: return upstream cursors unchanged so clients choose how much to read. File tools expose Capy's JSON upload/download URL negotiation, not arbitrary filesystem access or fetching signed URLs on a client's behalf.

Mark read operations with read-only annotations and mark mutating operations conservatively; destructive or costly operations must not be advertised as harmless or automatically approved. Annotations are client guidance, not authorization. Required API request IDs remain explicit client inputs rather than server-generated IDs, preserving retry identity across MCP calls.

## Packaging and documentation

Provide a Node.js CLI executable for STDIO, a Worker entry point, a locked dependency tree, build/typecheck/test/generation scripts, Wrangler configuration, and CI that runs local checks and a Worker bundle validation without deployment credentials. Enable Worker observability without logging application payloads or secrets. Do not deploy to Erin's Cloudflare account or publish a package as part of implementation unless asked.

The README covers local installation/build/run, a Hermes STDIO configuration and remote MCP configuration verified against its current documentation, Worker secret provisioning and deployment, group selection, the Captain-to-thread messaging flow, issue state/label lookup, error/retry semantics, and the coverage exclusions. Include contribution and security-reporting guidance. Open-source readiness does not authorize choosing a license on MLH's behalf: leave the package private/unpublished and explicitly note that a license decision is required before public distribution.

## Verification and acceptance

- Generation tests account for every operation, with only the six documented exclusions; regenerated files match the committed snapshot and catalog.
- Unit tests cover schema references/unions/required fields, names, selection, encoded path/query parameters, bodies, upstream errors and rate limits, cancellation/timeouts, response limits, redirect refusal, and secret redaction.
- MCP client integration tests initialize, list tools, and exercise representative Captain/issue/message calls against mocked Capy responses. Invalid arguments and disabled tools never reach upstream.
- A real child-process STDIO test verifies initialization, tool discovery, and clean stdout without requiring credentials for a live Capy account.
- Worker-runtime tests verify initialization/tool calls and authentication, Origin, routing, method, and concurrent-request isolation behavior using the same catalog.
- Typechecking, tests, production CLI build, package-content inspection, and Worker dry-run bundling pass.
- Tests do not create real Captains, issues, or billable work. A live API smoke test is optional and only occurs if credentials are supplied; report clearly if no live Capy or Hermes connection was verified.

## Non-goals and anti-goals

No OAuth authorization server, multi-user credential management, legacy SSE MCP transport, SSE-to-MCP streaming bridge, custom dashboard, autonomous polling daemon, or unofficial Capy endpoints. No claim of complete API coverage while silently dropping operations or schema constraints. No public deployment with a shared Capy key and unauthenticated access.

## Builder decisions

Choose currently supported SDK/tooling versions, module/file layout, schema compiler, exact sanitized error representation, resource bounds, and test tooling during planning. Prefer the smallest implementation that satisfies these observable behaviors. Changes to API scope, authentication model, or transport support require revisiting this design.
