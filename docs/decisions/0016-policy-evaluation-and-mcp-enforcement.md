# ADR 0016: Policy evaluation and enforcement in the MCP pipeline

- Status: Accepted
- Date: 2026-11-16

## Context

POL-1/2/3 define grants, scope and field rules; POL-7 a dry evaluation; POL-8 an audit
event per decision with its rule; MCP-2 per-user tool lists where a non-granted tool is
an unknown tool; MCP-3 argument validation before policy; SEC-1 server-side
enforcement on every call. Phase 1 deferred one finding: `McpServer` rejected unknown
tools and invalid arguments before `api`'s audit wrapper ran. There are no adapters
yet.

Options and decisions keep their original numbers. Item 1 concerned how the documentation was
organised, not the system, and is omitted.

## Options considered

2. **Who handles `tools/list` and `tools/call`:** `McpServer.registerTool` with Zod
   schemas converted from JSON Schema; the low-level `Server` with `api`'s own handlers.
3. **Several roles per user:** first mapped role wins; union of grants.
4. **Several grants for one operation:** most permissive; first that passes, in
   configuration order.
5. **Scope argument absent:** treat as unconstrained; deny.
6. **Audit shape:** one row per call with the decision in it; a `policy.decision` row per
   decision plus the existing `tool.call` row for calls that ran.
7. **Built-in tool `ping`:** remove; keep as a built-in for every authenticated caller.
8. **What an allowed call does before adapters exist:** fail the configuration; a
   `NoAdapterInvoker` behind a core `OperationInvoker` port.

## Decision

2. **Low-level `Server`** with handlers in `api`. Every rejection — unknown or
   non-granted tool, invalid arguments, policy denial — then passes through code that
   audits it. Answers mimic `McpServer` exactly: `ProtocolError(-32602, "Tool <name> not
   found")` for a missing tool (the same for unknown and non-granted, so the list does
   not leak), an `isError` result `Input validation error: …` for bad arguments.
   Validation uses Ajv against the configured JSON Schema, which is also what
   `tools/list` publishes. `tools.listChanged` is advertised as `false` (per-request
   servers have no event bus; shown by a Phase 0 experiment).
3. **Union**: a user in two groups gets both roles' grants.
4. **First grant that passes, in configuration order**; if none passes, the denial
   names the first grant's first failing check. Deterministic and explainable.
5. **Deny** (`scope_argument_missing`): a search without `brand` would otherwise return
   every brand.
6. **`policy.decision` + `tool.call`**, linked by the correlation ID. AUD-1 lists policy
   decisions and tool calls separately, and denied calls then leave exactly one row.
   `tools.list` and `auth.rejected` are also recorded. A failed audit write before
   execution stops the call; denials are returned even when their audit write fails.
7. **Keep `ping`** as a built-in available to every authenticated caller (rule
   `builtin`), like the MCP-8 built-ins that follow; the Phase 1 acceptance keeps its
   meaning.
8. **`OperationInvoker` port** in core, default `NoAdapterInvoker` in `api` (an explicit
   `isError` result); Phase 3 replaces it with the direct execution path (MCP-4).

Rule references are `role:<role>/grant:<id|index>[/scope:<arg>|/deny_fields|/allow_fields]`,
`default-deny`, `builtin`.

## Consequences

- `api` owns two JSON-RPC handlers and must track SDK changes to `tools/*` shapes
  (result projection goes through `Server.projectCallToolResult`).
- `Server` carries `@deprecated` in SDK 2.4.0 ("use `McpServer` … only use `Server` for
  advanced use cases"); the one construction site suppresses the lint rule with this
  reason. If a later SDK removes it, `McpServer` would need a hook before argument
  validation and unknown-tool rejection to keep this pipeline.
- Two audit rows per allowed call; Phase 8's hash chain covers both.
- The union of roles can widen access when groups overlap; operators see the effective
  rule in audit and, from Phase 8, in `explain`.

## Verified

2026-11-16, `@modelcontextprotocol/server@2.4.0`:

- `dist/createMcpHandler-DzlXH0KL.d.mts` line 233:
  `type McpServerFactory = (ctx) => McpServer | Server | Promise<McpServer | Server>`.
- `dist/mcp-oHn3ureC.mjs` lines 1584–1643 (`McpServer.setToolRequestHandlers`): a missing
  tool throws `ProtocolError(ProtocolErrorCode.InvalidParams, "Tool ${name} not found")`;
  input validation failures are thrown inside the `try` and returned as
  `createToolError("Input validation error: Invalid arguments for tool ${name}: …")`,
  i.e. `{ content: [{type:'text', text}], isError: true }`; results pass through
  `server.projectCallToolResult` (lines 1235–1250 document that low-level handlers call
  it themselves).
