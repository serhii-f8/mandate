# ADR 0003: MCP SDK, transport and long-running operations

- Status: Accepted
- Date: 2026-11-16

## Context

[SPEC](../SPEC.md) requires one Streamable HTTP MCP endpoint at protocol 2026-07-28 (MCP-1), a
per-user tool list from role grants (MCP-2), long-running operations through MCP Tasks (MCP-7), and
a stateless `api` that runs as several instances (NFR-3). The API server is NestJS (SPEC
section 3). This was decided in Phase 0, spike 1.

Revision 2026-07-28 changed the ground under these requirements: the protocol is stateless (no
`initialize`, no `Mcp-Session-Id`; version and capabilities travel in every request's `_meta`;
`server/discover` replaces the handshake), `tools/list` may vary by the authorization on the
request but not per connection, and Tasks moved out of core into the official extension
`io.modelcontextprotocol/tasks` (`tools/call` returns `resultType: "task"`; `tasks/get`,
`tasks/update`, `tasks/cancel`; no `tasks/list`). Two SDK lines are on npm:
`@modelcontextprotocol/sdk` 1.32.2 and the split `@modelcontextprotocol/server` / `client` 2.4.0.
MCP-Nest 2.0.10 wraps the v2 SDK for NestJS.

## Options considered

1. **SDK v1 (`@modelcontextprotocol/sdk` 1.32.2).** Implements up to 2025-11-25; no
   `server/discover`. Cannot meet MCP-1.
2. **SDK v2 (`@modelcontextprotocol/server` 2.4.0 + `@modelcontextprotocol/node` 2.1.2) used
   directly behind a NestJS controller.** `createMcpHandler(factory)` serves 2026-07-28 with a
   fresh server per request; the factory gets `authInfo`. No Tasks runtime in the SDK: the
   extension's methods are registered as custom-schema handlers by the platform.
3. **MCP-Nest 2.0.10.** Serves 2026-07-28 statelessly via the same `createMcpHandler`; per-caller
   tool filtering only through per-tool `requiredRoles`/`requiredScopes` metadata; no Tasks
   support; microservice-strategy architecture with peer dependencies on `@nestjs/microservices`,
   Fastify and Express.
4. Task-state placement: (a) process memory with `Mcp-Name`-based instance affinity; (b) a store
   every instance reads.

## Decision

- **SDK package and version:** `@modelcontextprotocol/server` 2.x (verified 2.4.0) and
  `@modelcontextprotocol/node` 2.x (verified 2.1.2) in `api`; `@modelcontextprotocol/client` 2.x
  (2.4.0) plus `@modelcontextprotocol/ext-tasks` (0.2.3) in tests and the conformance harness.
  Exact versions pinned in Phase 1.
- **Stateless transport configuration:** one POST endpoint served by
  `createMcpHandler(factory, { responseMode: 'json', legacy })`. The legacy posture (`'reject'` =
  modern-only, or the SDK's default `'stateless'` fallback for 2025-era clients) is set after
  spikes 2 and 3 show what Claude Desktop and ChatGPT speak; the spike ran `'reject'` (decided in
  the addendum below). In front of the handler: bearer verification (`requireBearerAuth` contract,
  `OAuthTokenVerifier` backed by Phase 2 token validation), Host and Origin validation. No session
  store, no sticky routing.
- **Per-user tool lists:** built per request. The factory receives the verified `AuthInfo`, asks
  `PolicyEngine` (in-memory configuration, NFR-6) for the caller's granted operations and registers
  only those on a fresh `McpServer`. A tool that is not granted is absent from `tools/list` and a
  call to it fails as an unknown tool. List results stay `cacheScope: "private"` (SDK default).
- **Long-running operations:** the Tasks extension, implemented in `api`. For a client that
  declares `io.modelcontextprotocol/tasks` in the request's client capabilities, `tools/call` of a
  long-running operation commits a task row, then returns `{ resultType: "task", taskId, status:
  "working", createdAt, lastUpdatedAt, ttlMs, pollIntervalMs }`. `tasks/get`, `tasks/update`,
  `tasks/cancel` are custom-schema request handlers that check the caller owns the task (unknown
  and foreign tasks both answer `-32602`) and read or write durable state. **Task state lives in
  PostgreSQL** (task row linked to the change-set; status derived from the change-set and its
  Temporal workflow); the work runs in `worker`. Any `api` instance can answer any task request, so
  `api` stays stateless. Task IDs are UUIDv4. Clients without the extension get an immediate result
  referencing the change-set (proposed SPEC change to MCP-7). The completed task's `result` is the
  full 2026-07-28 `CallToolResult`, including `resultType: "complete"`.
- **MCP-Nest vs SDK directly:** the SDK directly, mounted in a NestJS controller
  (`toWebRequest(req, req.body)` → `handler.fetch(request, { authInfo })` → write the `Response`).
  MCP-Nest is not used.

## Consequences

- The platform owns about 50 lines of glue (controller, auth gate, guards) and the Tasks handlers.
  If a future SDK release adds a Tasks server runtime, the handlers can be swapped; the store and
  ownership model stay.
- The per-request factory is the single place where identity becomes a tool list; Phase 2 plugs
  `PolicyEngine` in there. Per-request `McpServer` construction cost must be measured with
  realistic tool counts.
- `server/discover` advertises `tools.listChanged: true` by default; with per-request servers,
  list-change notifications need a shared `ServerEventBus` (pub/sub) or the capability should not
  be advertised.
- `McpServer.registerTool` adds `content: []` to a returned `CreateTaskResult`; `api` may own
  `tools/call` through the low-level handler to emit exactly `Result & Task`.
- Test clients must pin `versionNegotiation` to `2026-07-28` (client default is `'legacy'`), and
  the 2.4.0 client cannot consume `resultType: "task"` by itself: task-aware clients need ext-tasks
  with a host-written raw dispatcher.
- Real-client support of the Tasks extension (Claude Desktop, ChatGPT) is unknown, so the
  non-Tasks fallback in MCP-7 is required, not optional.
- MCP-Nest's guard/interceptor integration is not available; NestJS guards apply to the controller
  route as a whole, and per-tool authorization lives in `PolicyEngine`.

## Verified

- **What:** `spikes/1-mcp-sdk/run.sh` — two `node:http` processes (:4101, :4102) running
  `createMcpHandler` from `@modelcontextprotocol/server` 2.4.0 with a shared task directory; checks
  with `@modelcontextprotocol/client` 2.4.0 and `@modelcontextprotocol/ext-tasks` 0.2.3 on Node
  v22.20.0. 10/10 assertions pass: negotiated 2026-07-28 read from the wire, no `Mcp-Session-Id`
  and no `initialize`, per-user tool lists, cross-user call and cross-user task poll rejected, 401
  without or with an unknown token, task handle polled to completion, task started on one process
  and resumed and completed on the other, `tools/list` alternating between processes after a single
  `server/discover`. Negative control: with separate task directories the instance-switch assertion
  fails.
- **What (documents only, `unverified` experimentally):** MCP-Nest 2.0.10 capabilities, from its
  published source; client support for the Tasks extension.
- **Where:** spec pages under https://modelcontextprotocol.io/specification/2026-07-28/, ext-tasks
  `specification/2026-07-28/tasks.md`, package files under
  `spikes/1-mcp-sdk/node_modules/@modelcontextprotocol/`.
- **Date:** 2026-11-16.

## Addendum 2026-11-16: legacy clients, non-Tasks fallback, task ownership check

- **Legacy clients: decided.** The endpoint keeps the SDK default and serves 2025-era clients
  through the stateless legacy fallback. Reason: spikes 2 and 3 ran with that default, spike 3
  asserted that a 2025-11-25 client receives the same text result
  (`legacy-2025-client-gets-same-text`), and even the reference MCP Apps host shipped with ext-apps
  2.0.4 still used the 2025 handshake until patched. Rejecting such clients would lock out hosts
  that exist today. This matches [ADR 0005](0005-mcp-apps-widgets-and-fallback.md) decision 7. **Not tested on the legacy path:**
  per-user tool lists and long-running calls. Spike 1 itself ran with `legacy: 'reject'`. Phase 1
  must test per-user tool lists there; Phase 5 must decide what a legacy client gets in place of
  the Tasks extension.
- **The non-Tasks fallback in MCP-7 is a design proposal.** A client that does not declare the
  Tasks extension gets an immediate result with the change-set ID. The spike server returns error
  -32021 in that case; the proposed behaviour was not built in the spike. No real client was
  observed supporting the extension, so this fallback is likely the main path in practice and
  Phase 5 must treat it as such.
- **Task ownership check.** The spike assertion `bob-cannot-poll-alice-task` originally could not
  tell "foreign task" from "unknown task". It now first proves that the owner reads the same task
  ID on the same instance, then that the other user is refused.
