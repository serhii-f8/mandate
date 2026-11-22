# ADR 0029: Rulings for MCP Tasks and the api execution path, and a correction to ADR 0027

- Status: Accepted
- Date: 2026-11-17

## Context

[ADR 0027](0027-execution-on-temporal.md) decided how MCP Tasks (MCP-7), limits and the start of execution work in
Phase 5. Building the Tasks support and the api path settled questions that ADR 0027 left open,
and a check against the code found two earlier statements that do not match it.

## Options considered

Per ruling, the alternative is stated inline in the decision. Where an earlier decision or a
Phase 0 experiment gave an answer, it was followed.

## Decision

1. **Rulings for Tasks and the api path:**
   - (a) `tasks/*` without the declaration answer `-32021` "Missing required client capability"
     with `data.requiredCapabilities.extensions["io.modelcontextprotocol/tasks"] = {}`, as in
     the Phase 0 experiment ([ADR 0003](0003-mcp-sdk-and-transport.md)), with no side effect.
   - (b) A non-UUID task ID answers `-32602` before any lookup.
   - (c) `mcp_task.changeset_id` references `change_set(id)`.
   - (d) "Cancelled/expired while preparing" means `preparedAt` is unset.
   - (e) The drift count in the execution text comes from a new repository method `errorCounts`.
   - (e2) `submit_for_approval` answers an `ExecutorUnavailable` from `start` with a fixed text.
   - (f) The `calls_per_minute` check is folded into the policy decision: the call gets one
     `policy.decision` row, a deny that replaces the allow. A counter failure fails closed with
     `Rate limit check unavailable; the call was not completed.` Bucket key `<subject>|<role>`,
     UTC minute.
   - (g) `api` uses `Connection.lazy`, so it starts while Temporal is down. A failed start
     answers `executor_unavailable`.
   - (h) `asTask` and `task` are optional fields on the core invoker types
     (`InvocationRequest.asTask`, `InvocationResult.task`).
   - (i) `approval_required` and limit refusals are `isError: true`.
   - (j) The acceptance run counts Magento operations above a `magento_operation.id` watermark,
     not by timestamp, and checks that the number of Magento bulks equals the number of done
     batches.
   - (k) The seed uses async bulk in chunks of 500.
2. **Fixed result texts** for the failure codes `config_changed`, `preparation_interrupted`,
   `operation_unavailable`, `executor_error`, `executor_unavailable` and `workflow_closed` live in
   `CHANGESET_TEXT.errors` (core), next to the Phase 4 codes, so
   `preparationErrorResult` maps them to value-free texts (SEC-3) instead of the generic unknown
   read-error text.
3. **Corrections** (an addendum is added to [ADR 0027](0027-execution-on-temporal.md)):
   - Groups are stored only with the execution request, never at creation. ADR 0027 decision 2
     said `createChangeSet` stores the requester's groups; it does not, and must not: groups
     matter only for the re-check at execution (EXE-5).
   - `updated_at` on `change_set` already exists, so no migration is needed for it.

## Consequences

- Core gains the task port, `isTaskId`, the optional invoker fields and the `task.cancel` audit
  action.
- No SPEC change.

## Verified

2026-11-17, by reading the installed sources:

- `@modelcontextprotocol/server` 2.4.0, `dist/mcp-oHn3ureC.mjs:861`: the `Server` constructor
  copies `options.capabilities`.
- `:1187-1193`: `_ondiscover` returns `discoverAdvertisedCapabilities(getCapabilities())`.
- `:1446`: that function is a shallow copy, so `capabilities.extensions` passed to
  `new Server(...)` is advertised verbatim.
- `dist/src-DdvbAHrR.mjs:2872`: `extensions` is part of the server capability schema.
- `dist/src-DdvbAHrR.mjs:3753-3782`: `stampResultType` passes a non-`complete` `resultType`
  through for `tools/call`.
- `dist/mcp-oHn3ureC.mjs:986-998`: the low-level `tools/call` wrapper adds `content: []`
  (`normalizeContentlessToolResult`, `src-DdvbAHrR.mjs:633`) and validates the result. The
  Phase 0 experiment showed `taskId` etc. reaching the wire through the same wrapper.
- `@temporalio/client` 1.25.0, `lib/connection.d.ts:225`: `static lazy(options?)` creates a
  connection without checking it.
