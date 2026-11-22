# ADR 0056: Conformance baseline for 2025-11-25 on the stateless legacy path

- Status: Accepted
- Date: 2026-11-20

Refs: NFR-16, MCP-1

## Context

The conformance e2e test ([ADR 0055](0055-conformance-baseline-2026-07-28.md)) also runs the frozen 2025-11-25 requirement set of
`@modelcontextprotocol/conformance` 0.2.0-alpha.12. That revision uses the stateful `initialize`
handshake. The api serves it through the SDK's legacy fallback, `createMcpHandler(factory,
{ legacy: 'stateless', responseMode: 'json' })` in `apps/api/src/app.ts` ([ADR 0003](0003-mcp-sdk-and-transport.md)):
every 2025-era request gets a fresh server from the same factory over a
`WebStandardStreamableHTTPServerTransport` built with `sessionIdGenerator: undefined`, so no
`Mcp-Session-Id` is issued and GET and DELETE answer 405.

The first run with an empty baseline (`server: []`) passed `server-initialize`, `ping`,
`tools-list`, `resources-list` and `dns-rebinding-protection` and reported 25 unexpected scored
failures. 24 need a capability the platform does not offer: logging (`logging-set-level`,
`tools-call-with-logging`, which calls `logging/setLevel` first), completion, resource
subscriptions (`resources-subscribe`/`-unsubscribe`, capability `resources.subscribe` not
declared), prompts, sampling, elicitation, and the suite's fixture tools and `test://` resources.
Upstream issue modelcontextprotocol/conformance#516 (open, "Server scenarios fail servers for
capabilities they never declared") describes this class.

The 25th, `server-sse-multiple-streams`, reports one WARNING, `server-sse-multiple-streams-session`
("Server did not provide session ID"), and stops before sending its concurrent POSTs. The CLI counts
a WARNING as a failure. On the 2025-11-25 path the scenario returns early when the transport has no
session ID (`pr.run` in `dist/index.js`); on 2026-07-28 it skips the session step and sends the
POSTs, and it passes there (must-pass, [ADR 0055](0055-conformance-baseline-2026-07-28.md)).

## Options considered

1. **Issue session IDs on the legacy path** (a sessionful legacy handler routed with
   `isLegacyRequest` in front of a `legacy: 'reject'` handler, as the SDK documents). Rejected:
   sessions need shared state or sticky routing across api instances (NFR-3), and the 2025-11-25
   transport specification lets a server omit the session ID ("MAY assign").
2. **Baseline the whole `server-sse-multiple-streams` scenario.** Simple, but a future suite version
   that tests concurrency without a session would go unjudged.
3. **Baseline the single check `server-sse-multiple-streams:server-sse-multiple-streams-session`.**
   Any further check the scenario reports stays judged; a suite that stops warning makes the entry
   stale and fails the run, so the entry is revisited.

This is not an SDK defect: sessionless serving is the SDK's documented `'stateless'` mode and is
allowed by the specification. The suite's early return is a limitation of the scenario. No upstream
issue for it was found (`gh search issues --repo modelcontextprotocol/conformance` for
"multiple-streams", "sessionless", "session", 2026-11-20).

## Decision

Option 3. `expected-failures.2025-11-25.yaml` lists 24 whole-scenario entries and the one per-check
entry, each with a reason comment. `MUST_PASS['2025-11-25']` stays `server-initialize`, `ping`,
`tools-list`, `resources-list`, `dns-rebinding-protection`: they are the scored scenarios that
pass, and no other scored scenario exercises implemented behaviour. The not_scored scenarios of
this set fail only on fixtures: `json-schema-2020-12` (fixture tool `json_schema_2020_12_tool`);
`server-sse-polling` warns (no session, fixture tool `test_reconnection`, no priming event);
`server-session-lifecycle` skips (sessionless).

## Consequences

- Concurrent POSTs are proved by the 2026-07-28 run only; on the legacy path the suite cannot
  exercise them while the api stays sessionless.
- If the api ever issues sessions on the legacy path, the per-check entry becomes stale and the run
  fails until it is removed.

## Verified

- Specification 2025-11-25, Transports, Session Management
  (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports, read 2026-11-20): "A
  server using the Streamable HTTP transport **MAY** assign a session ID at initialization time".
- SDK `@modelcontextprotocol/server` 2.4.0: `dist/createMcpHandler-*.d.mts` documents `legacy:
  'stateless'` ("a fresh instance ... constructed with only `sessionIdGenerator: undefined` ... GET
  and DELETE ... `405`"); `dist/index.mjs` `createLegacyStatelessFallback` builds the transport with
  `sessionIdGenerator: void 0` and answers non-POST with 405.
- Conformance 0.2.0-alpha.12 `requirements/2025-11-25.yaml` (server list and not_scored);
  `dist/index.js` scenario classes `server-sse-multiple-streams` (early WARNING without session ID),
  `tools-call-with-logging` (`setLoggingLevel` before the fixture tool), `resources-subscribe`.
- Experiment, 2026-11-20: `cd apps/api && pnpm exec vitest run --project e2e
  test/e2e/conformance.e2e.test.ts` with `server: []` -> 2025-11-25 exit 1, "Total: 36 passed, 25
  failed"; with this baseline -> both tests pass, summary `conformance 2025-11-25: 33 scenarios;
  scored: 35 success, 24 failure, 1 warning, 0 skipped, 1 info; not_scored: 1 success, 1 failure,
  3 warning, 0 skipped, 5 info`. Mutation `legacy: 'reject'` in `app.ts` -> `server-initialize` and
  `tools-list` fail, so the run exercises the legacy path.
