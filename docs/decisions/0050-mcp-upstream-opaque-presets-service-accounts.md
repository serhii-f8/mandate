# ADR 0050: MCP upstream adapter, opaque writes, preset packages, service accounts

- Status: Accepted
- Date: 2026-11-19

## Context

Phase 9 (SPEC §7) delivers the MCP upstream adapter with pinning (CONN-1, CONN-4, SEC-6),
`write_opaque` handling, preset loading as versioned packages (CONN-8), the code-operation path
(OPS-5, OPS-6 remainder), a second preset built only through public interfaces, and service
accounts (AUTH-4).

Found in the code before deciding: the schema already accepts `adapter: mcp` with `mcp_url` but
nothing runs it; one OpenAPI adapter instance per process and no dispatch by adapter kind;
`write_opaque` (and `destructive` without a manifest) is refused at run time ("not supported yet");
a write binding without `bulk` fails with `write_mode_unsupported`; no code-operation hook; presets
are directories found by `package.json` name with an exact version check; no service-account notion.

## Options considered

1. **Split of the work:** one part; five (adapter, opaque, presets/code, second preset, service
   accounts).
2. **MCP client:** a hand-written JSON-RPC client over the existing HTTP client; the official
   `@modelcontextprotocol/client` with a guarded `fetch`.
3. **Pin granularity (CONN-4):** one hash over the whole tool list; one hash per tool recorded on
   the operation.
4. **Pin checking:** at load only; at load plus a periodic monitor plus a freshness check on the call
   path; before every call.
5. **Upstream unreachable at load:** reject the configuration; load it with the connection's
   operations unverified (disabled).
6. **SEC-6 input schemas:** pass the upstream schema; require an operator-written schema; derive it
   from the pinned schema with prose keywords removed, overridable.
7. **MCP tools with manifests:** support `write` with diff on MCP tools; refuse in Phase 9.
8. **Opaque change-set shape:** zero items; one item carrying the raw arguments.
9. **Opaque approval under `above_threshold`:** count zero (no approval); unknown count (approval).
10. **Opaque execution retry:** retry like other writes; at most once (record before sending), with an
    opt-in idempotency header for OpenAPI endpoints that deduplicate.
11. **Preset packages:** npm-installed into `node_modules` of the app; preset directories that accept
    unpacked packages and `node_modules` layouts, with an `aiops` field in `package.json`, a semver
    range in configuration and an SDK range in the package.
12. **Code operations:** arbitrary hooks into `core` ports; three kinds (`read`, `write` records,
    opaque `call`) over a guarded HTTP client in a context, under the existing read-before-write writer.
13. **Second system:** WooCommerce, NetBox, Directus, Gitea.
14. **Service-account identification:** by group membership of the service-account user; by `azp`
    listed in a `service_accounts` configuration key, with claim checks.
15. **Third-party server for acceptance:** only a fake; a real published server plus a fake for the
    change criterion.

## Decision

1. **Five parts**, built in the order adapter → opaque → presets → gitea → service accounts; each
   part adds one group to `scripts/acceptance/phase-9.sh`.
2. **`@modelcontextprotocol/client` 2.4.0** in `packages/adapters/src/mcp/` only (new boundary rule),
   `versionNegotiation: { mode: 'auto' }`, empty client capabilities, `inputRequired.autoFulfill:
   false`, `onInsufficientScope: 'throw'`, era cached per connection, a guarded `fetch` that applies
   the egress rules, credential injection, timeouts, size cap, scrubbing and instrumentation.
3. **One pin per tool** on the operation (`upstream: { tool, pin }`), hash
   `aiops.mcp-tool.v1` over name, title, description, input and output schema, annotations; `_meta`
   excluded. A list-wide hash would disable unaffected operations on any change; CONN-4 asks to
   disable "the affected operations".
4. **Load + monitor every `pin_check_seconds` (default 300) + a call-path refresh when the last list is
   older than 60 s;** worker re-verifies right before an opaque call. State changes audited
   (`upstream.pin`). Before every call would double the latency of every read.
5. **Load with `unverified` operations.** An upstream outage must not block unrelated configuration
   changes; the operations stay disabled until a list succeeds (fail closed).
6. **Derived schema without `description`, `title`, `examples`, `$comment`, `default`**, overridable
   by `input_schema`; `description` of the operation required in configuration.
7. **Refused in Phase 9** (known gap): an MCP tool result has no declared shape to diff against.
8. **One item** `target_id: call`, `before: null`, `after: <normalized args>`: every count, batch,
   progress, outcome and view mechanism works unchanged and no workflow command changes.
9. **Unknown count → approval required** (reason `opaque`) unless the rule is `never`.
10. **At most once**, submission recorded before sending; a resumed batch with a recorded submission is
    `failed/no_outcome`. With `idempotency: { header }` the call is resent with the same key. The
    response body is not stored (known gap: no created-resource ID for the requester).
11. **Preset directories with the `aiops` field**, `node_modules` layouts accepted, semver range in
    `presets[].version` (a bare version stays exact), SDK range checked, `operation_prefix` aliases,
    code files in the configuration hash, generic Dockerfile copy of `presets/*/dist`.
12. **Three code kinds over `CodeContext.http`** (never a credential), plus declarative per-record
    writes with `{ record: <field> }` templates and bulk key mapping (OPS-6 remainder).
13. **Gitea** (single SQLite container, CLI-created admin and token, Swagger 2.0, per-record PATCH,
    labels by ID → a natural code operation). Image `gitea/gitea:28.3.0` (published 2026-11-01; the
    endpoints are confirmed in [ADR 0051](0051-mcp-upstream-opaque-presets-service-accounts-details.md)).
14. **`azp` in `service_accounts`, `client_id == azp`, no `sid`;** a configured `azp` failing the other
    checks is rejected; groups ignored; subject `service:<client_id>`; no decisions, no step-up.
15. **`@modelcontextprotocol/server-everything` 2.2.1** (published 2026-11-04) for attachment and
    grants, plus the fake MCP server of `@aiops/testing` in a container for the changed-description
    criterion (a published server's descriptions cannot be changed at run time).

[SPEC](../SPEC.md) §3 is amended: the MCP row names `@modelcontextprotocol/client` for MCP upstreams in
`packages/adapters`, and the repository layout lists `presets/gitea-issues/`.

## Consequences

- Connector SDK 0.6.0 and the configuration schema gain additive fields only (NFR-18): `tool`/`pin`
  upstream, `pin_check_seconds`, `code` upstream, `{ record }` templates, `bulk.status.key`,
  `idempotency`, `operation_prefix`, `service_accounts`, preset `adapter`.
- `api` and `worker` change only in wiring and in the generic paths (composite adapter, opaque router
  branch, writer selection, service-caller roles); the Gitea preset must not touch them, and the
  acceptance script checks that from git history.
- Known gaps: no manifests on MCP tools; opaque results not stored; list-changed notifications unused
  (polling only); a legacy (2025) upstream costs one `initialize` per call; service accounts cannot
  roll back (page-only) and have no per-account rate limit until Phase 10.

## Verified

2026-11-19:
- `@modelcontextprotocol/client@2.4.0` (installed; `npm view` latest 2.4.0),
  `node_modules/.pnpm/@modelcontextprotocol+client@2.4.0/.../dist/client-BTIWJvaF.d.mts:245-300`
  (`versionNegotiation` modes `legacy` default, `auto`, `pin`), `index-BCNZS4Ap.d.mts:1649`
  (`StreamableHTTPClientTransportOptions.fetch`, `requestInit`); `listTools` walks pages up to
  `listMaxPages` 64; `callTool` returns `isError` rather than throwing; `inputRequired.autoFulfill`
  defaults to true. Experiment (two throwaway scripts): `mode: 'auto'` against
  a stateless server built like `apps/api` negotiated 2026-07-28 without a session; against a legacy
  stateful server `server/discover` got 400 and the client fell back to `initialize` with a session;
  `pin` against the legacy server failed `ERA_NEGOTIATION_FAILED`; a custom `fetch` saw every request
  and injected headers reached the server. `listChanged` in the modern era needs an open
  `subscriptions/listen` stream; a stateless legacy server answers the GET stream with 405.
- Keycloak `quay.io/keycloak/keycloak:26.8.2` with `--features=cimd,resource-indicators`, the repo's
  realm import and bootstrap (throwaway container): a confidential client with
  `serviceAccountsEnabled` and the client-credentials grant gets `azp` = `client_id` = the client ID,
  `preferred_username` `service-account-<id>`, `sub` = the service-account user ID, no `sid`, no
  `auth_time`, no refresh token (also with `scope=offline_access`); `aud` contains the MCP resource
  through the `mcp:tools` default scope, equals it exactly with `resource=<resource>`, and another
  resource is `invalid_target`; user tokens (alice) carry `sid`; a regular user named
  `service-account-x` could be created, so `preferred_username` is not trusted.
- npm: `@modelcontextprotocol/server-everything` versions 2.2.1 (2026-11-04), 2.3.1 (2026-11-18).
  Docker Hub: `gitea/gitea` 28.3.0 (2026-11-01), 28.4.0 (2026-11-15).
