# Spike 1 — MCP SDK (protocol 2026-07-28)

Throwaway experiment. Question: can the official TypeScript SDK serve one
stateless Streamable HTTP endpoint at protocol `2026-07-28`, with a tool list
per authenticated user and a long-running call exposed through the MCP Tasks
extension, across two processes that share nothing but a task store?

Finding: [docs/reports/phase-0-spike-1-mcp-sdk.md](../../docs/reports/phase-0-spike-1-mcp-sdk.md).
Decision: [docs/decisions/0003-mcp-sdk-and-transport.md](../../docs/decisions/0003-mcp-sdk-and-transport.md).

## Prerequisites

- Node v22 (tested with v22.20.0) and npm. No Docker.
- Ports 4101 and 4102 free on 127.0.0.1 (`run.sh` kills leftovers on them).

## Files

- `server.mjs` — plain `node:http` server. `createMcpHandler` from
  `@modelcontextprotocol/server` 2.4.0 builds a fresh `McpServer` per request
  from the caller's `AuthInfo`; `requireBearerAuth` answers 401 for missing or
  unknown tokens; `alice-token` gets `search_products` and `slow_export`,
  `bob-token` gets `list_orders`. `slow_export` returns a Tasks-extension
  `CreateTaskResult` and finishes about 3 s later; task state is one JSON file
  per task under `TASK_DIR` (default `./.task-state`). `tasks/get`,
  `tasks/update`, `tasks/cancel` are registered as custom-schema handlers.
- `check.mjs` — client checks with `@modelcontextprotocol/client` 2.4.0
  (pinned to `2026-07-28`) and `@modelcontextprotocol/ext-tasks` 0.2.3. A
  recording `fetch` captures every HTTP exchange; assertions read the wire.
- `run.sh` — clean start (kill port owners, wipe `.task-state` and `logs`),
  two servers on :4101 and :4102 sharing one `TASK_DIR`, run checks, stop servers.

## Run

```bash
npm ci        # run.sh does this if node_modules is missing
./run.sh      # one PASS/FAIL line per assertion; exit 0 only if all pass
```

Server logs are in `logs/server-4101.log` and `logs/server-4102.log`.

## Tear down

`run.sh` stops both servers on exit. Remove local state with
`rm -rf node_modules .task-state logs`.
