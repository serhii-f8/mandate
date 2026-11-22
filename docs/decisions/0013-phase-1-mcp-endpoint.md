# ADR 0013: The Phase 1 MCP endpoint

- Status: Accepted
- Date: 2026-11-16

## Context

Phase 1 must serve a stateless MCP endpoint with one hard-coded tool (MCP-1, NFR-3)
whose calls appear in audit. Authentication (AUTH-1) and per-user tool lists from
grants (MCP-2) are Phase 2, but MCP-1 asks Phase 1 to verify per-user tool lists on the
2025-era legacy path ([ADR 0003](0003-mcp-sdk-and-transport.md) addendum).

## Options considered

1. **Caller identity before Phase 2:** a static development bearer token; no
   authentication with a fixed `anonymous` caller; Keycloak tokens already.
2. **Legacy posture:** `legacy: 'reject'` or the SDK default `'stateless'`.
3. **Response mode:** `auto`, `sse`, `json`.
4. **Audit write failure:** return the tool result anyway; fail the call.
5. **What the audit row holds:** full arguments and result; tool name and outcome only.

## Decision

1. No authentication in Phase 1. A `CallerResolver` seam returns `anonymous`; Phase 2
   replaces it with token validation. Per-user lists on both eras are proven in the
   e2e test by overriding the resolver and the tool catalogue (the factory reads the
   caller from `authInfo.extra`).
2. `legacy: 'stateless'` ([ADR 0003](0003-mcp-sdk-and-transport.md) addendum, [ADR 0005](0005-mcp-apps-widgets-and-fallback.md) decision 7).
3. `responseMode: 'json'`; Phase 1 has no mid-call notifications, and Phase 5 revisits
   for progress.
4. Fail the call (`isError: true`) when the audit write fails.
5. Tool name, outcome, duration and correlation ID only; arguments are not stored
   until redaction exists (Phase 3, SEC-3, AUD-4).

Also: Host and Origin are validated by `api` (the SDK handler checks neither); one
correlation ID per HTTP request, returned in `x-correlation-id` and stored in the row;
the hard-coded tool is `ping`.

## Consequences

- The Phase 1 stack must not be exposed beyond `127.0.0.1`; Compose binds that way.
  Phase 2 turns the endpoint into a protected resource and then 401 is the answer to
  unauthenticated requests.
- `client_id` in audit holds only a verified client identity, so it is empty in
  Phase 1 and the token's client ID from Phase 2. The client's self-declared name
  (from the 2026-07-28 request envelope, absent on legacy requests) is recorded as
  `details.declaredClientName`, so rows of the append-only table never mix verified and
  unverified values in one column.

## Verified

2026-11-16, `@modelcontextprotocol/server@2.4.0`
`dist/createMcpHandler-DzlXH0KL.d.mts`: `CreateMcpHandlerOptions.legacy?: 'stateless' |
'reject'` (default `'stateless'`; legacy GET/DELETE answer 405), `responseMode` (`json`
drops mid-call notifications), `maxRequestBodySize` default 4 MiB;
`McpHandlerRequestOptions { authInfo?, parsedBody? }`; `McpRequestContext { era,
authInfo?, requestInfo? }`. `dist/mcp-BCJHyo7l.d.mts`: `getClientVersion()` is
deprecated but backfilled per request from the validated envelope on 2026-07-28.
`@modelcontextprotocol/node@2.1.2` exports `hostHeaderValidation`, `originValidation`,
`toWebRequest`, `toNodeHandler`. Behaviour on both eras is asserted by the `MCP-1`
e2e tests.
