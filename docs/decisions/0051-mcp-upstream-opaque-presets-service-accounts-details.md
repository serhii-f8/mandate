# ADR 0051: MCP upstream, opaque writes, presets and service accounts in detail

- Status: Accepted
- Date: 2026-11-19

## Context

[ADR 0050](0050-mcp-upstream-opaque-presets-service-accounts.md) decides how Phase 9 builds the MCP upstream adapter, opaque writes, preset
packages, the Gitea preset and service accounts. Working those decisions out against the code
showed places where they were silent, ambiguous or wrong. This record lists the calls made for
the five parts (adapter, opaque, presets, gitea, service accounts). Items are numbered 1 to 76;
where the code cites an item by another label (adapter rulings R1, R2 and R8, ruling F14), the
label is given with the item.

## Options considered

For each item below, the first wording of ADR 0050 against the option taken here. Each item
states why the first option did not fit the code.

## Decision

**MCP adapter:**

1. **Nothing from the live tool list fails a configuration load** (adapter ruling R1; amends ADR
   0050 decision 6). Phase 8 needs every process, and the CLI that may not reach the upstream, to
   load a revision identically. A pinned tool whose derived schema cannot compile is a fifth pin
   state, `schema_invalid` (not offered, refused like `changed`).
2. **The derived schema is built at run time by the pin monitor** (adapter ruling R2) from the
   live tool whose hash equals the pin. At load the operation has a placeholder schema, no
   validator, and the loader's static check of grant scope arguments is skipped for it, as for an
   unresolved spec. Scope is still enforced on every call (POL-2; a missing scope argument denies,
   [ADR 0016](0016-policy-evaluation-and-mcp-enforcement.md)).
3. **The derived schema keeps an allow-list of JSON Schema validation keywords** instead of
   removing five prose keywords, so `x-…` or unknown keys cannot carry upstream text either.
4. **Stale rule:** after failed refreshes an operation becomes `unverified` once its last
   successful list is older than 2 × `pin_check_seconds`.
5. **Retries** use the HTTP client's existing retriable set (timeout, network, 429, 502, 503,
   504) and retry the whole connect-plus-request.
6. **The guarded fetch answers GET with 405** itself, so a 2025-era server cannot hold a
   long-lived stream and a concurrency slot; error bodies (JSON, at most 64 KiB) are passed to the
   SDK for version negotiation and never reach an outcome, log or audit row.
7. **The `upstream_changed`/`upstream_unavailable` refusal sits in `OperationRouter`** (adapter
   ruling R8) for every MCP-backed operation, so the opaque path inherits it. `tools/list` stays
   synchronous and starts a background refresh of a stale connection. The first state of an
   operation is audited only when it is not `ok`.
8. **The pin monitor runs in `api` only.** The worker uses the stateless `verifyPinNow` right
   before an opaque call (the only worker use). Load-time listing may use the vault
   (`createAdapters({ credentialFor })`).
9. **Connector SDK 0.6.0 is set once**, with the adapter; the later parts add to 0.6.0.
10. **Acceptance:** `@modelcontextprotocol/server-everything` 2.2.1 runs as
    `npx … streamableHttp`, `PORT` (default 3001), endpoint `/mcp`, Node ≥ 24 (read from the
    package source); the fake MCP server is built from `@aiops/testing` into an image
    (`tooling/acceptance/fake-mcp.Dockerfile`) with a `/_control/tools/<name>` endpoint that
    changes a description at run time.

**Opaque writes:**

11. `approvalRequirement` takes a required `opaque: boolean`; an operation missing from the
    snapshot counts as destructive and opaque (strictest).
12. `OpaqueCaller` is bound to one operation: `call({ args, idempotencyKey, beforeSend })`. The
    `beforeSend` hook records the submission after the credential and pin checks and immediately
    before the request leaves. The SDK gains `WriteAdapter.callOnce` (a new method on a versioned
    interface; 0.6.0, NFR-18) with that hook in the HTTP client; a private address found at
    connect time therefore fails after the record, which is safe (`no_outcome`).
13. **Outcome classes:** 2xx → `written` whatever the body; 429 and other 4xx →
    `upstream_rejected`; 3xx → `no_outcome` (a POST answered 303 may have been applied); timeout,
    network, 5xx → `no_outcome`. Upstream batch ID `opaque:<batch key>`. A pre-flight failure
    (including a temporary OAuth token failure) is final for that change-set.
14. An interrupted opaque preparation continues instead of failing `preparation_interrupted`
    (there is no upstream read to replay). `not_excludable` is decided in core `deriveChangeSet`
    after the requester check. `kind` is derived from the current configuration's operation (a
    removed operation shows as `diff`); the prepared answer and task results carry `kind`, and
    `args` when opaque.
15. **Stricter loader:** an opaque OpenAPI binding may not be GET or carry `bulk`; `idempotency`
    only on opaque operations, its header not a platform, credential or already-declared header;
    grants of `write_opaque` need approval steps unless `required: never`. This can refuse a
    configuration that loaded before (see "Upgrade notes").
16. No workflow command changes (verified by reading `changesetWorkflow`); one new replay history
    `opaque-executed`, the 33 existing ones unchanged.

**Presets:**

17. A code write is `write(ctx, records, args)`: it also receives the change-set's validated
    arguments.
18. **No runtime `definePreset`:** code mounted outside `/app` cannot resolve
    `@aiops/connector-sdk`, so preset code imports `@aiops/*` as types only (new lint rule) and
    default-exports an object `satisfies PresetModule`.
19. The code module is imported with a digest of its code directory in the URL, and that digest
    is hashed into the configuration. A running process that sees the same entry file with a
    changed digest refuses the load with "restart the process" (Node would otherwise serve the old
    nested modules).
20. Per-record and code writes are a second mode of `ManifestBatchWriter` (`directFor`) next to
    the unchanged bulk path; any `retriable` record outcome throws so the activity retries and
    read-before-write marks the written records `already_applied`; `failed` → `upstream_failed`.
21. Contract helpers in `@aiops/testing` take the loader and adapters as parameters (a dependency
    would create a workspace cycle): `presetConnectionYaml`, `replayRecordings`, `contractRead`,
    `contractWrite`, `recordingsFreeOf`.
22. The image builds and `pnpm pack`s every `presets/*` package; `semver` 7.8.6 (already in the
    lockfile) becomes a direct dependency of `@aiops/config`.
23. Target IDs stay strings; the loader requires `read_before.ids_arg` items to be strings. A
    preset whose upstream uses integers declares a numeric string pattern and converts in code.
    `response.items: '$'` maps a bare JSON-array response; a total from a response header is not
    supported.
24. `BulkMapping.status.index` becomes optional, exclusive with the new `key` (a type widening in
    0.6.0).

**Gitea preset** (facts verified on a throwaway `gitea/gitea:28.3.0` container, 2026-11-19):

25. `issues.search` is a code read: the list endpoint returns a bare array with the total only in
    `X-Total-Count`. Issue numbers are strings at the platform boundary. The selector is
    `with_labels` (open issues having any of the names) with `state` fixed to `open`, so
    exactly-one-of `numbers` / `with_labels` is enforced by property count
    ([ADR 0026](0026-update-content-target-selection-without-root-combinators.md)); pages are 50 (Gitea's cap).
26. `issues.set_labels` stays a code write: `PUT …/labels` accepts names or IDs but silently
    drops unknown ones (200), so the code looks names up first, refuses an unknown name without
    sending, and checks the answer. OPS-5 is genuinely exercised.
27. **History check:** every commit that builds the Gitea preset carries a
    `Plan: phase-9-mcp-upstream-gitea` trailer; the range runs from the parent of the first such
    commit to the last; its diff over `packages/core`, `apps/api`, `apps/worker` must be empty,
    and every commit in the range must carry the trailer.

**Service accounts:**

28. **A service caller is marked by its subject `service:<client_id>`, not by a stored `kind`**
    (amends ADR 0050 decision 14). The approval start and the worker's execution guard rebuild the
    caller from the stored actor and groups; a `kind` field would be lost there and every approved
    service write would be denied. The prefix is reserved: a user token or a page login whose
    `sub` starts with `service:` is rejected.
29. Token refusals use the existing audit action `auth.rejected` with reasons
    `service_account_mismatch` and `reserved_subject` (there is no `auth.token`).
30. A token counts as client credentials only when the `client_id` claim is present and `sid` is
    absent (the test issuer's user tokens have no `sid`); an unconfigured one has its groups
    dropped (no roles). With no active configuration no client is configured (fail closed).
31. Core `checkDecision` refuses a service approver (`not_approver`), in addition to hiding
    `review_changeset` and `decide_changeset`; `config diff` gains a `service_account` entity
    kind; `config explain` takes exactly one of `--groups` and `--service`.
32. Compose default `${AIOPS_KEYCLOAK_SERVICE_ACCOUNTS-aiops-sa-ci}` (an explicit empty value
    creates none); the bootstrap never deletes clients and never sends a secret on update;
    acceptance reads the secret through the admin API into
    `tooling/acceptance/service-token.mjs`, never argv or logs.

## Consequences

- ADR 0050 decisions 6 and 14 are amended by items 1–2 and 28.
- Connector SDK 0.6.0 contains, besides ADR 0050's additive fields, `WriteAdapter.callOnce`, the
  code operation types, and the optional `BulkMapping.status.index`. All are additive or widening
  (NFR-18).
- Item 15 may refuse a configuration that loaded under Phase 8; the release notes of Phase 10
  must say so.

## Verified

2026-11-19, Gitea `gitea/gitea:28.3.0` (built 2026-11-01), throwaway container, removed
afterwards: `INSTALL_LOCK` and SQLite via environment; `gitea admin user create … --admin` and
`gitea admin user generate-access-token --raw --scopes write:issue` work; `write:issue` covers
every preset call including private repositories, a `read:issue` token gets 403 on the label PUT;
`/swagger.v1.json` is Swagger 2.0, base path `/api/v1`; auth header `Authorization: token <t>`;
issue PATCH answers 201; the issue list returns a bare JSON array with `X-Total-Count`, its
`labels` filter matches any of the names, page size capped at 50, labels returned as objects;
`PUT …/labels` takes IDs or names and drops unknown ones with 200.
`@modelcontextprotocol/server-everything@2.2.1` package source: `streamableHttp` argument, `PORT`
default 3001, path `/mcp`, `engines.node >= 24`.

## Addendum 2026-11-20: rulings made during implementation

Implementing the five parts produced rulings that change or add to the statements above. Items
continue the numbering; each says what was decided and why the earlier wording did not fit.
Labels in parentheses (F2, R10, T7 and so on) are the labels the rulings carried when they were
made; some code comments cite them.

**MCP adapter:**

33. **`schema_invalid` is refused with `upstream_unavailable`, not `upstream_changed`** (corrects
    item 1). The tool did not change, so the `upstream_changed` text would be false; a pin in
    `changed` or `missing` stays `upstream_changed`. The tests were written against this.
34. **A legacy session is closed with a real `DELETE`** (F2). `Client.close()` only aborts the
    transport; `transport.terminateSession()` (through the guarded fetch, errors swallowed) runs
    before `close()` when a session id exists, otherwise a session-based server keeps one session
    per call.
35. **`lastFailure()` of the guarded fetch is the most recent failure, used only when the SDK
    error comes from the transport** (F8; refines item 6). Era negotiation makes the 400 on
    `server/discover` an expected non-2xx exchange; any other SDK or protocol error is
    `upstream_error`.
36. **The tool hash is over the SDK-parsed definition** (F14). `listTools` strips unknown
    annotation keys and drops `execution`; a list the SDK rejects is `invalid_response`. A
    non-object root schema stays a `deriveMcpInputSchema` case (`schema_invalid`).
37. **The strict Ajv compiler (`strict: true`) is kept for derived schemas** (F15, refines items
    2-3). Union `type: [...]`, `properties` without `type`, or a `required` name not in
    `properties` make the pin `schema_invalid`; operators give `input_schema` for such tools. A
    relaxed compiler would be a second validation dialect.
38. **The connection test calls the declared test operation only when its listed hash equals the
    pin** (F6); otherwise `ok: false, code: 'mapping'` and no call. It was the one call path
    outside the router's refusal (CONN-4).
39. **The live tool list shows in `configuration.disabled` and so in `config diff`** (F20). The
    hash, apply's no-op check and policy do not depend on it, so it is accepted; CLI, api and
    worker may list different disabled sets for one revision.

**Opaque writes:**

40. **`OpaqueCaller` is bound to one operation, `call({ args, idempotencyKey, beforeSend })`**
    (R2; refines item 12). Pre-flight, record and send must happen in that order inside one
    adapter exchange; the hook is the only way to record after the credential and pin checks and
    before bytes leave.
41. **`WriteAdapter.callOnce` is a new method of a versioned interface, not an additive field**
    (R3, NFR-18). Only adapters implement `WriteAdapter`, so presets are unaffected.
42. **`CallTarget` is `{ kind: 'http'; mapping: UpstreamMapping } | { kind: 'mcp'; tool: string }`**
    (F5). "The mapping type of `ReadAdapter.read`" named nothing: MCP calls go through
    `McpToolAdapter.callTool`. The OpenAPI adapter answers an `mcp` target `not_sent/mapping`.
    (Superseded for code by item 50.)
43. **`SendOptions.discardBody`** (F3). The transport answered `invalid_response` for a 2xx
    without a JSON body and parsed every other body; with the option any 2xx ends
    `{ status, json: null }` on headers and the response is destroyed unread. `callOnce` always
    sets it, so the outcome depends on the status only.
44. **429 is `upstream_rejected`, a 3xx is `no_outcome`, any 2xx is `written` whatever its body**
    (R10; refines item 13). A POST answered 303 may have been applied; the body is never parsed
    into the outcome.
45. **`beforeSend` sits after the allow-list and the semaphore slot** (F4). The client runs the
    scheme check and `assertEgressAllowed` first (refusal: `egress_denied`, hook not called). A
    401 is returned as `refused` with no refresh and resend (`noResend()` on the guarded fetch
    once the hook has resolved).
46. **Outcome after `beforeSend`** (F7). `ProtocolError`, a result with `isError` or a transport
    4xx is `refused`; abort, timeout, network, 5xx and other SDK errors are `unknown`. Not-sent
    codes `busy`, `timeout`, `network`, `http_status`, `upstream_error`, `invalid_response` read
    `upstream_unavailable`; `mapping` reads `upstream_rejected` (F9).
47. **The pin is checked per call with `verifyPinNow` against the configuration of that call**
    (F8, F20); `toolLister` is optional in `WriterForDeps`; no lister or no evaluation is
    `not_sent/upstream_unavailable`.
48. **`executionSettings` gives an opaque operation `batchSize: 1`** (F2). It threw
    `operation_unavailable` for any operation without a manifest, which every test harness hid by
    installing `settingsFor`.
49. **The SDK stub `toolDefinition` passed to `callTool` disables `Mcp-Param` header mirroring**
    (T7). SDK 2.4.0 otherwise resends `tools/call` on -32020; at-most-once (EXE-4) outranks
    mirroring, so a server that requires mirrored headers refuses opaque calls. `input_required`
    reads `unknown`. Verified: `@modelcontextprotocol/client` 2.4.0, `public-CvV4ZHkX.mjs:3866`.

**Presets:**

50. **Code calls go through `CodeAdapter.codeCall` with `beforeSend` first; `CallTarget` gets no
    `code` member** (F3; supersedes item 42's note). Pre-flight is the credential and a `call`
    code operation, then `beforeSend`, then `codeCall` (`ok` accepted, `definite` refused, else
    unknown); log method `CODE`; `callOnce`'s "status only, body discarded" contract does not fit
    code.
51. **A per-record writer starts no request after a retriable answer** (F10; refines item 20).
    In-flight ones finish and unsent records answer `retriable`; the batch throws, and the retry
    marks written ones `already_applied`.
52. **Loader tightenings** (F25): `aiops.code` must be in a subdirectory, `aiops.sdk` is required
    when `aiops` exists, and a per-record binding on GET is refused. Adding `aiops` to Magento's
    `package.json` changes the configuration hash of every Magento configuration.
53. **Preset package selection also scans `<dir>/node_modules`** (T2-M1) and reads every
    `package.json` there.
54. **Only the entry directory of the code module is hashed** (T3-M2); a `../` or absolute file
    import escapes the digest. An unreadable tree gives `code directory cannot be read` (T3-M3,
    new message).
55. **Disabled code operations are listed with method `CODE`** (T4-M4).
56. **Code requests share the connection semaphore** (T8-M8), and a rejected OAuth token stays
    cached after a write 401 (pre-existing, `client.ts`); a write-only code operation keeps its
    401 until a read refreshes.
57. **Direct mode never calls `recordSubmission`**, so a superseded attempt can still write (T9);
    bulk has the same exposure. It is not covered by AUD/EXE fencing in this phase.
58. **The inverse writer of a per-record write receives the original change-set args** (T11-M1),
    not the forward call's.
59. **`onCodeError` logs the code module's operation name** (e.g. `boom`), not the operation ID:
    that is what the SDK `CodeAdapter` receives and changing it is an SDK interface change.
60. **Other calls:** `{ record }` in `path_params` may name only `id_field` or a
    `write.carry_fields` member (F20); in key mode the adapter reports an unknown key out of range
    so core filters it (F19); a per-record binding whose path has no `{record}` loads (T6-M3,
    every record hits one URL); an aliased ID over 64 characters is an issue at `operation_prefix`
    (T5).

**Gitea preset:**

61. **Authentication is `bearer` with the bare 40-hex token, not `api_key` with `token <hex>`**
    (F4). The value has a space and `HEADER_SAFE` rejects it; Gitea accepts
    `Authorization: Bearer <t>`. The credential is entered with `page-api.mjs put-credential`; no
    `put_api_key` helper. Amends the Verified line "auth header `Authorization: token <t>`" for
    use, not for fact.
62. **A 2xx label PUT is `ok` whatever it answers** (F8; refines item 26). Core's verify read
    compares arrays in order, so reordered labels end `skipped/drift`; `failed` stays for definite
    refusals (unknown name before send, 4xx). The README says to give labels sorted.
63. `config diff` prints only `+ preset <id>` for an added preset, no version. Acceptance check 1
    reads the version from the loaded package.

**Service accounts** (items 65, 67 and 74 are not used):

64. The local closure `rolesOf` in `policy-engine.ts` is renamed `rolesFor`; the imported
    `rolesOf(caller, config)` keeps its name.
66. `AUTH-4` is added to the `decision.test.ts` case "step_up_required when authTime is missing";
    a service approver without the step role is answered `not_found`, the refusal a human gets.
68. `configuration.current` is caught as `ConfigurationUnavailableError` only; other errors
    rethrow.
69. The `service_account` diff kind is added to `EntityKind` as well as `KIND_ORDER`.
70. Tool objects are asserted `visibleTo(...) === false`; "not listed, not callable" is tested in
    `tool-pipeline.test.ts`.
71. Acceptance group 4 uses `gitea_approve`, an `sa_client` that fetches a fresh token per call,
    a delta check of `create_note` calls, and `service-token.mjs --count-secret` so the secret
    never reaches bash.
72. The reserved prefix is tested with `startsWith(SERVICE_SUBJECT_PREFIX)`, so a bare `service:`
    is rejected.
73. The `config explain` usage text in the CLI and in [commands](../commands.md) names
    `--service`.
75. **`config explain` refuses a `service:` `--subject` with `--groups`, and an empty
    `--service`** (extends item 31). The reserved namespace applies to explain, so it cannot
    impersonate a service account.
76. **The Keycloak bootstrap relies on realm default scopes to give `mcp:tools`** (fails closed
    if the scope is missing) **and overwrites the flow flags of listed clients**; it still never
    deletes a client or sends a secret on update (item 32).

### Corrections to items above

- Item 1: `schema_invalid` is refused with `upstream_unavailable`, not like `changed` (item 33).
- Item 12: a private address found at connect after the record answers `not_sent/egress_denied`,
  not `no_outcome`: the guarded lookup refuses before a socket opens, so nothing was sent and the
  attempt is not safe by luck but by construction (F17, R4). The hook shape is item 40.
- Item 13: 429 and 3xx are fixed by item 44; pre-send failures map as in item 46.
- Item 20: a retriable answer stops new requests (item 51).
- Item 26 and the Verified line on the auth header: see items 61-62.

### Upgrade notes

- Item 15 and R13: the loader refuses a `write_opaque` grant without approval steps (unless
  `required: never`), an opaque GET or `bulk` binding, and a bulk write on a destructive operation
  without a manifest. A configuration that loaded under Phase 8 can be refused; the only fixture
  affected is `read-config`.
- Item 52: the Magento `package.json` gains `aiops`, which changes the configuration hash. A
  stored revision from before the upgrade is refused `configuration_mismatch` until
  `config apply` is re-run.
- Item 37: MCP tools whose schemas fail strict Ajv need an operator-supplied `input_schema`.
- Item 39: `config diff` may show `disabled ~` lines that move with the live tool list.
- Item 49: servers that require mirrored `Mcp-Param` headers refuse opaque calls.
- Item 61: the Gitea credential is the bare token, entered on the credential page.
