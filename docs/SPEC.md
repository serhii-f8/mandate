# Mandate — Technical Specification

Version 1.0. This document specifies the product. Requirement identifiers from sections 5 and 6
(`MCP-1`, `POL-3`, `NFR-7`, ...) are cited in code comments, test names and commit messages. Decisions
cited as "ADR NNNN" are in the [decision records](decisions/README.md). For a guided introduction,
start with the [guide](guide/README.md).

## 1. Scope and design principles

The system is a self-hosted, open-source MCP server that sits between AI clients and a company's business systems. It decides who may run which operation, prepares write operations as reviewable change-sets, routes them through human approval, executes them reliably, and records everything.

It is one MCP endpoint per installation. Employees connect their AI client to it and to nothing else. Credentials for business systems are stored only on the platform.

### Design principles

- **Default deny.** A role sees and can call only the operations explicitly granted to it. Operations that are not granted are not listed to the client.
- **The model is not trusted.** The model translates a request into a tool call. Permission checks, diffs, approval screens and execution are server code with no model in the path.
- **Approve a fixed artifact.** An approval applies to an immutable change-set identified by a content hash. Any change produces a new change-set.
- **Configuration as code.** Roles, connections, operations and limits are YAML files validated at load time. There is no general-purpose admin panel.
- **Small trusted UI.** Web UI is limited to approval, credential entry, audit view and change-set detail. The same components are delivered as in-chat widgets and as standalone pages.
- **Reuse upstream APIs.** Business systems are reached through their existing REST APIs or MCP servers. No direct database access.
- **Generic adapters, curated presets.** Any MCP server or OpenAPI spec can be attached without code. Preview, batching and rollback for an operation are added through a declarative manifest.
- **Client independent.** Authorization, change-sets, approvals and execution behave identically for any MCP client. Presentation follows what the client declares: clients that cannot render widgets receive text plus a link, and clients without the Tasks extension follow a change-set with `get_changeset` (MCP-7).
- **Single-tenant installation.** One deployment serves one organization.

## 2. Architecture

The platform runs as two processes built from one codebase, plus three infrastructure services. An optional third-party MCP gateway may sit in front of it; nothing sits between it and the business systems.

### Components

| Component | Kind | Responsibility |
| --- | --- | --- |
| `api` | Our process | MCP endpoint, tool registry, policy checks, change-set creation, widget resources, REST API for trusted pages |
| `worker` | Our process | Temporal worker: operation lifecycle workflows and activities that call upstream systems |
| `web` | Our static bundle | Trusted pages; also the source of widget bundles |
| PostgreSQL | Infrastructure | Configuration snapshot, connections, encrypted credentials, change-sets, approvals, audit |
| Temporal | Infrastructure | Durable execution of operation workflows |
| Identity provider | External | User login and group membership (Keycloak bundled; Okta or Entra supported) |
| AI client | External | Claude, ChatGPT, terminal or custom MCP clients |
| Business systems | External | Reached through their REST APIs or MCP servers |

### Request path for a write operation

1. The AI client calls a `prepare` tool on the `api` MCP endpoint with a bearer token issued by the identity provider.
2. `api` validates the token, resolves the user's role, and evaluates policy against the operation and its arguments.
3. `api` starts an operation workflow in Temporal, keyed by the new change-set ID.
4. A `worker` activity reads current state from the upstream system through the adapter and stores the computed diff as a change-set in PostgreSQL.
5. `api` returns a text summary that contains the fallback URL, plus structured content for the widget. The widget itself is linked from the tool definition (`_meta.ui.resourceUri`), not from the result.
6. The requester submits the change-set for approval, from the widget or by calling a tool.
7. The workflow waits until the change-set is approved, cancelled or expired. An approver decides on the trusted page; decisions are stored rows, and after the last approval `api` starts execution, which wakes the workflow with a signal that carries no data (ADR 0030). Deciding in a widget is an opt-in per role, through an approval tool declared with `_meta.ui.visibility: ["app"]`, and is never available for operations that require step-up authentication or are `destructive`: hiding that tool from the model is enforced by the host, not by the server (ADR 0008). The audit records the channel of every decision.
8. On approval, `worker` activities write to the upstream system in batches, storing prior values for rollback.
9. Progress is exposed through workflow queries. The final result is written to audit and sent to notification channels.

Read-only and low-risk operations skip steps 3 to 8: `api` checks policy, calls the adapter directly, and writes an audit entry.

### Boundaries

| Concern | Owner |
| --- | --- |
| Understanding the user's request, choosing a tool | AI client and model |
| Authentication, group membership | Identity provider |
| Authorization, change-sets, approvals, execution, audit, widgets | Platform |
| Business validation of written data | Upstream system |
| Catalog and federation of unrelated MCP servers | Optional external gateway |

## 3. Technology stack and repository layout

The whole system is TypeScript in one pnpm monorepo. Payload CMS is not used.

| Layer | Choice |
| --- | --- |
| Language and build | TypeScript, Node LTS, pnpm workspaces, Turborepo |
| API server | NestJS |
| MCP | Official TypeScript SDK v2 (`@modelcontextprotocol/server` and `@modelcontextprotocol/node`; not `@modelcontextprotocol/sdk` 1.x), `createMcpHandler` mounted in a NestJS controller, protocol 2026-07-28 (stateless by protocol); Tasks extension implemented in `api`; MCP-Nest not used (ADR 0003); MCP upstreams reached with `@modelcontextprotocol/client` from `packages/adapters` (ADR 0050) |
| Workflows | Temporal, TypeScript SDK |
| Database | PostgreSQL with Drizzle ORM and SQL migrations |
| Authorization | In-house RBAC evaluator behind a `PolicyEngine` interface |
| Identity | OAuth 2.1 resource server; Keycloak 26.8.x bundled as the default authorization server, started with `--features=cimd,resource-indicators` (both experimental in Keycloak) |
| Secrets | Envelope encryption in PostgreSQL; master key from environment or KMS |
| Widgets and pages | React, Vite with `vite-plugin-singlefile`, `@modelcontextprotocol/ext-apps` 2.x (its peers are the split SDK packages `@modelcontextprotocol/server`, `/client`, `/core` ^2.0.0) |
| Configuration | YAML validated with Zod schemas |
| OpenAPI adapter | OpenAPI parser plus Ajv for argument validation |
| Observability | OpenTelemetry traces and metrics, structured JSON logs |
| Tests | Vitest, Testcontainers, Temporal test environment |
| Packaging | Docker images, Docker Compose |
| License | Apache 2.0 |

### Repository layout

```
apps/
  api/              NestJS: MCP endpoint, REST API for pages, auth guards
  worker/           Temporal worker: workflows and activities
  web/              React: trusted pages
packages/
  core/             domain model, policy evaluation, manifest engine, diff
  db/               Drizzle schema, SQL migrations, migrator, repositories (ADR 0011)
  adapters/         mcp-upstream adapter, openapi adapter
  widgets/          React components built as MCP Apps and as page parts
  connector-sdk/    types and helpers for presets and code operations
  config/           YAML schemas, loader, validation, CLI
  testing/          in-memory executor, fake upstream, fixtures
  temporal/         payload codec, Temporal executor and workflow starter, workflow contract (ADR 0027)
  upstream/         configuration load options and the upstream reader shared by api and worker
presets/
  magento2-catalog/ curated operations and manifests for Magento 2
  gitea-issues/     second preset: Gitea issues, built only through public interfaces (ADR 0050)
deploy/
  docker-compose.yml  api, worker, postgres, temporal, keycloak
docs/
```

`packages/core` has no dependency on NestJS, Temporal, a database driver or any adapter. `api` and `worker` depend on `core`, `db` and the infrastructure packages (`config`, `connector-sdk`, `adapters`, `upstream`, `temporal`); `db` implements the repository interfaces owned by `core`; adapters depend on `connector-sdk` only.

## 4. Domain model

Nine entities carry the system. Configuration entities are loaded from YAML; runtime entities live in PostgreSQL.

| Entity | Source | Key fields | Notes |
| --- | --- | --- | --- |
| Connection | YAML | `id`, `adapter`, `base_url` or `mcp_url`, `credential_ref`, `preset` | One per upstream system instance |
| Credential | Database | `ref`, `ciphertext`, `key_version` | Entered on a trusted page; never in YAML |
| Operation | YAML or preset | `id`, `connection`, `upstream`, `risk`, `input_schema`, optional `manifest` | The unit that is granted, called and audited |
| Manifest | YAML or preset | `id_arg`, `scope_args`, `read_before`, `batch_size`, `rollback`, `fields` | Makes an operation previewable and reversible |
| Role | YAML | `id`, `grants[]`, `limits`, `approval` | Mapped from identity provider groups |
| Grant | YAML | `operation`, `scope`, `deny_fields` | Belongs to a role |
| ChangeSet | Database | `id`, `operation`, `requester`, `args`, `hash`, `status`, `stats` | Immutable after `prepared` |
| ChangeItem | Database | `changeset_id`, `target_id`, `before`, `after`, `status`, `error` | One row per affected record |
| AuditEvent | Database | `id`, `ts`, `actor`, `action`, `subject`, `decision`, `correlation_id`, `prev_hash` | Append-only, hash-chained |

Approvals are stored as rows linked to a change-set: `approver`, `decision`, `comment`, `ts`, `auth_time`, plus the round, step, the hash and number of changes the approver saw, and the channel (ADR 0030).

### Operation risk classes

| Class | Meaning | Default handling |
| --- | --- | --- |
| `read` | No state change upstream | Policy check, direct call, audit |
| `write` | State change with a manifest | Change-set, approval per role rules, workflow execution |
| `write_opaque` | State change without a manifest | Approval shows raw arguments; no diff, no rollback |
| `destructive` | Deletes or irreversible effects | Always requires approval and step-up authentication; the only risk class for a manifest `delete` (ADR 0071) |

### Change-set lifecycle

`preparing` → `prepared` → `pending_approval` → `approved` → `executing` → `completed` or `completed_with_errors` or `failed`.

Side exits: `rejected`, `expired`, `cancelled` from any state before `executing`; `failed` from `preparing` when preparation cannot complete; `cancelled` from `executing` when a cancellation stops the execution after its current batch (EXE-7); `rolling_back` → `rolled_back` (or `failed`) after execution, from `completed`, `completed_with_errors`, and from `cancelled` or `failed` when execution had started and written items, while the rollback window is open (ADR 0042); `pending_approval` → `prepared` when an approver returns the change-set with a comment, after which the requester may submit it again (a new approval round) or cancel it (ADR 0030). A change-set that does not require approval moves from `prepared` to `executing` when the requester confirms (ADR 0024).

## 5. Functional requirements

Requirements are grouped by module. Each has a stable ID for reference in issues and tests.

### 5.1 MCP server

- **MCP-1** Expose one Streamable HTTP MCP endpoint conforming to protocol version 2026-07-28, which is stateless by protocol: no `initialize` handshake, no `Mcp-Session-Id`, every request carries its version and capabilities. Clients that still speak the 2025-era protocol are served through the SDK's stateless legacy fallback (ADR 0003); Phase 1 verifies per-user tool lists on that path; such clients get the non-Tasks result of MCP-7 (ADR 0027).
- **MCP-2** Return a per-user tool list built from the user's role grants. Tools not granted are absent from the list, and a call to one is rejected as an unknown tool. `tools/list` results are marked `cacheScope: "private"`.
- **MCP-3** Validate every tool call's arguments against the operation's input schema before any policy or upstream call.
- **MCP-4** Return structured tool results with a short text summary suitable for clients without widget support.
- **MCP-5** Serve widget bundles as MCP Apps UI resources (`ui://` URI, MIME `text/html;profile=mcp-app`, one self-contained HTML document) and link them from tool definitions with `_meta.ui.resourceUri`; results carry the widget's data in `structuredContent`.
- **MCP-6** Include a fallback HTTPS URL to the trusted page in the text content of every result of a tool that declares a widget, when the result refers to a change-set; a refusal that names no change-set has no page to link (ADR 0035). The same text goes to every client; the server does not vary results by client capability.
- **MCP-7** Expose long-running operations through the MCP Tasks extension (`io.modelcontextprotocol/tasks`): to a client that declares the extension on the request, `tools/call` returns a task handle (`resultType: "task"`) and `tasks/get`, `tasks/update`, `tasks/cancel` are served by any `api` instance from durable task state in PostgreSQL, with an ownership check on every task request. A client that does not declare the extension, including a 2025-era client on the legacy path, receives a result carrying the change-set ID after a bounded wait: the outcome when the work finished within it, otherwise the current status, which it follows with `get_changeset` (ADR 0027).
- **MCP-8** Provide built-in tools independent of connections: `list_my_operations`, `get_changeset`, `submit_for_approval`, `cancel_changeset`, `rollback_changeset`. `rollback_changeset` checks that a rollback is possible and returns the trusted-page link where the rollback is confirmed (SEC-8, ADR 0042).
- **MCP-9** Tool names and descriptions come from the operation definition and can be overridden in configuration.
- **MCP-10** Provide the built-in tool `create_plan`, listed to every authenticated caller, which puts 2 to 20 change-sets the caller prepared in order (CS-9) and answers the plan with each step's position, ID, operation and status. Its arguments (a title of 1 to 200 characters without control characters, and change-set UUIDs) are validated before anything runs; a refusal names its fixed reason and, when there is one, the change-set. A change-set the caller did not request is answered as `not_found`, exactly as an unknown one (SEC-1). `get_changeset` of a plan step carries `plan: { id, title, step, of, steps }`, where a sibling step shows only its position, ID, operation and status (ADR 0074).

### 5.2 Identity and authentication

- **AUTH-1** Act as an OAuth 2.1 resource server: validate signature, issuer, audience and expiry of every access token; the audience must equal the MCP endpoint's canonical URL (the RFC 8707 resource).
- **AUTH-2** Publish RFC 9728 protected resource metadata at the root and the path-suffixed well-known URL, and answer unauthenticated MCP requests with 401 and a `WWW-Authenticate` header carrying `resource_metadata`.
- **AUTH-3** Resolve roles from identity provider group claims through a configurable mapping.
- **AUTH-4** Support service accounts for non-interactive clients through the client credentials grant, each mapped to a role.
- **AUTH-5** Authenticate trusted pages through OIDC login against the same identity provider.
- **AUTH-6** Enforce step-up authentication on approval when the operation or role requires it, by checking `auth_time` against a configured maximum age.
- **AUTH-7** Never forward the user's access token to an upstream system.
- **AUTH-8** The realm configuration shipped for the bundled Keycloak accepts pre-registered clients and Client ID Metadata Documents from configured trusted domains by default; anonymous Dynamic Client Registration is off by default and can be enabled with a redirect-URI host allow list. PKCE with S256 is enforced for every client, however it was registered. The shipped realm lets a user obtain a refresh token when the client requests `offline_access` (claude.ai does): users hold the realm default roles and the `offline_access` client scope is mapped to its role (ADR 0009). The platform itself issues no tokens.

### 5.3 Policy

- **POL-1** Deny by default. A call is allowed only when a grant in the caller's role matches the operation.
- **POL-2** Evaluate scope constraints against call arguments, for example allowed brands or categories.
- **POL-3** Reject calls that touch fields listed in `deny_fields` or outside an allow-list when one is set. For an operation whose manifest takes `records_arg`, the touched fields are the union of the records' keys without `id_field`, so one denied field in one record denies the call (ADR 0070).
- **POL-4** Enforce limits per role: records per operation, records per day, calls per minute, concurrent executions.
- **POL-5** Determine whether approval is required from operation risk class, record count thresholds and role rules. A grant may carry its own rule, which replaces the role's for the calls it allows, and a rule may list field rules: the first one naming a field the call touches replaces it. The same resolution applies at submission, at execution start and in `config explain`; when the touched fields cannot be read and the rule has field rules, the change is unroutable and is not approved or executed (ADR 0066).
- **POL-6** Re-evaluate policy at execution start, so a role change after preparation is honoured.
- **POL-7** Provide a dry evaluation entry point that returns the decision and the matching rule without side effects.
- **POL-8** Record every decision, allow or deny, as an audit event with the rule that produced it.

### 5.4 Connections and adapters

- **CONN-1** MCP upstream adapter: connect to a remote MCP server by URL, fetch its tool list, and register each tool as a disabled operation.
- **CONN-2** OpenAPI adapter: load a spec from URL or file and register each endpoint as a disabled operation with a derived input schema. The adapter accepts Swagger 2.0 as well as OpenAPI 3 and supports importing a filtered subset of operations.
- **CONN-3** Inject the stored credential into upstream calls. Supported schemes: bearer token, API key header, basic, OAuth client credentials and, for upstreams that offer nothing else, the OAuth password grant (RFC 6749 §4.3; the client authenticates by Basic header or by body fields, a token is fetched again on expiry or a 401 and no refresh token is used; ADR 0065) and OAuth 1.0a request signing (RFC 5849; HMAC-SHA256 by default, HMAC-SHA1 on request; each attempt is signed over its method, URL and query with a fresh nonce; not available on MCP connections; ADR 0065).
- **CONN-4** Pin upstream MCP servers by recorded tool-list hash. A changed tool name, schema or description disables the affected operations until re-approved in configuration.
- **CONN-5** Restrict outbound calls to hosts declared in connections. Block private and link-local address ranges unless explicitly allowed per connection.
- **CONN-6** Apply per-connection timeout, retry policy, concurrency limit and, when `rate.requests_per_second` is set, a minimum interval between requests (retries included). A `Retry-After` the client honours also holds later requests of the connection. A request whose turn is further away than the connection timeout fails as `busy`. The interval is kept per process (ADR 0064).
- **CONN-7** Provide a connection test that performs one declared read call and reports the result.
- **CONN-8** Load presets as versioned packages that contribute operations and manifests for a connection. A preset may declare typed parameters with defaults (`params`); a connection that binds it may set their values (`preset_params`), which replace every `{ $param: <name> }` node in the preset's operations and test for that binding before the operation schema is checked. Unknown names and values of another type are refused at the connection, values are never coerced, and code operations receive the values as `ctx.params` (ADR 0067).

### 5.5 Operations and manifests

- **OPS-1** An operation is enabled only when declared in configuration or in an applied preset.
- **OPS-2** A manifest declares: identifier argument, scope arguments, the read operation that returns current state, the fields subject to diff, batch size, and the rollback strategy. The values come either as one object for every target (`values_arg`) or as an array of records, each with its own values (`records_arg`, which names the targets itself); exactly one of the two (ADR 0070). `action: update | create | delete` (default `update`) says what the call does to its targets: a `create` needs `records_arg`, and a `delete` needs `ids_arg` or `selector`, takes no values and needs risk `destructive` (ADR 0071). The `read_before` of a create or delete must find a record by identifier whatever its scope: it must not pass a scope argument, and the platform checks the scope on the returned record. A create binding should refuse an existing identifier upstream; that a create never overwrites an existing record is claimed only under such a read. A manifest may also declare `verify_after`, the verify-after stage with its own checks and lookups (EXE-12).
- **OPS-3** Supported rollback strategies: `replay_previous_state`, `inverse_operation`, `none`.
- **OPS-4** Support a selector form of input, for example brand plus filter, that the platform resolves to a concrete list of target IDs during preparation.
- **OPS-5** Allow an operation to be implemented in code through the connector SDK when a manifest is insufficient.
- **OPS-6** Mark upstream bulk endpoints in the manifest so the executor uses them instead of per-record calls. The manifest declares the bulk route, the status route and how per-item results are mapped (index or key).
- **OPS-7** A manifest may declare up to 5 `lookups`: reads of an enabled read operation with `fields_arg` on any connection, keyed per item by the target ID, a field of the item's `after` or `before`, or a field of the current record. During preparation each lookup reads the distinct keys of the pending items of a read chunk; its results feed the preparation checks (CS-3) and are never stored, shown, audited or returned (SEC-3). A failed lookup read fails the preparation with `lookup_failed` and the upstream status; a truncated one, or a page with fewer records than the total the upstream reports, fails it with `incomplete_read`; neither is read as "not found". The write operation's policy decision covers its lookups; the requester needs no grant on the lookup operation. A lookup read uses the egress rules, pacing and credential of its own connection (ADR 0072).

### 5.6 Change-sets

- **CS-1** Preparation performs no writes upstream.
- **CS-2** Store one ChangeItem per target with `before` and `after` values for the manifest's fields that the call changes (ADR 0024). With `records_arg` an item's `after` holds exactly the fields its record gave (ADR 0070).
- **CS-3** Exclude targets that fail validation or lack required data, and record the reason per item. A manifest may declare ordered preparation `checks`, each a code and a list of predicates from a closed set (`present`, `absent`, `equals`, `in`, `found`, `not_found`) over the item's `after` and `before`, the current upstream record, the call arguments and lookup results; no expressions. An item that passed the built-in exclusions and fails a check is excluded with the first failing check's code. Checks run at preparation only; their outcome is in the hash through each item's status and reason, and their inputs are never stored (ADR 0072).
- **CS-4** Compute a SHA-256 hash over operation ID, normalized arguments and ordered items. The hash is shown on approval and verified before execution. Each change-set stores the version of the hash format it was sealed with and, from version 2, its manifest action, which version 2 binds into the hash. Both are fixed with the hash. Every verification recomputes with the stored version; an unknown version is a hash mismatch. New preparations use the current version; a derived change-set keeps its source's version and action (ADR 0069).
- **CS-5** Allow the requester to exclude items before submission. Exclusion produces a new hash. A change-set derived from a plan step (CS-9) that is still `prepared` takes the source's place in the plan in the transaction that seals it, and the source leaves the plan; derived from a source in any other status, or when its preparation fails, it is outside the plan (ADR 0074).
- **CS-6** Expire change-sets after a configurable period. Expired change-sets cannot be approved or executed.
- **CS-7** Detect drift at execution: if an item's current upstream value differs from its stored `before`, skip the item and report it. Absent is `null`: a create item has `before: null`, a delete item `after: null`; a current state equal to `after` is already applied, one equal to neither is drift, and after a write a state not equal to `after` is `failed/not_applied` for a create still absent or a delete still present, while for an update it remains `skipped/drift` (ADR 0071). The stored action must equal the operation's current action, else execution is refused as `policy_denied`; a change-set without a stored action counts as `update`.
- **CS-8** Provide export of a change-set as CSV and XLSX.
- **CS-9** A plan puts 2 to 20 change-sets in order: a title (1 to 200 characters, no control characters) and the change-set IDs, each listed once. Only the requester of every listed change-set may create it, and each must be `prepared`, not expired and in no other plan; the plan is created in one transaction or not at all, with the fixed refusals `not_found`, `not_requester`, `not_prepared`, `already_in_plan`, `duplicate_step`, `too_few_steps` and `too_many_steps`. Each change-set keeps its own hash, approval and workflow; its plan and 1-based step are outside the hash and change only while it is `preparing` or `prepared`. Creating a plan is audited as `plan.created` (ADR 0074).

### 5.7 Approvals

- **APR-1** Route approval requests to users holding the approver role named in the requester's role configuration.
- **APR-2** Enforce separation of duties: the requester cannot approve their own change-set.
- **APR-3** Support single and multi-step approval chains.
- **APR-4** Support approve, reject, and return with comment.
- **APR-5** The approval view, on the page and in a widget alike, is rendered from data the server reads from storage, never from content supplied by the model or the client: original request text, requester, client, policy check results, statistics, a random sample of items with re-sampling, and full item access.
- **APR-6** The approve action states the number of changes being approved.
- **APR-7** Approval links are single-purpose, require login, and carry no authority by themselves.
- **APR-8** Approval decisions are made on the trusted page. Deciding in a widget is an opt-in per role, off by default, and never available for operations that require step-up authentication or are `destructive`. The channel of every decision (`page` or `widget`) is recorded in audit.

### 5.8 Execution

- **EXE-1** One Temporal workflow per change-set, with the change-set ID as workflow ID.
- **EXE-2** Workflow inputs and activity arguments carry identifiers only. Item data is read from PostgreSQL inside activities.
- **EXE-3** Execute in batches of the manifest's size. Each batch is one activity with a retry policy.
- **EXE-4** Every upstream write carries an idempotency key derived from change-set ID and item ID where the upstream supports it; otherwise the activity checks current state before writing. For asynchronous upstream bulk endpoints the activity records the upstream batch identifier before polling and, on retry, resumes polling it instead of resubmitting.
- **EXE-5** Record per-item outcome. A failed item does not stop the remaining batches unless the failure rate exceeds a configured threshold.
- **EXE-6** Expose progress through a workflow query: total, done, failed, skipped. During the verify-after stage (EXE-12) the status stays `executing` and the change-set's statistics carry the verification counts (pending, confirmed, unconfirmed); the final status counts unconfirmed items as errors (`completed_with_errors`).
- **EXE-7** Support cancellation before and during execution. Cancellation during execution stops after the current batch. A cancellation during the verify-after stage (EXE-12) stops the verification at its next look: pending items become `unconfirmed` with `verify_cancelled`, and the change-set ends with the status its items give, not `cancelled`, because every write already happened.
- **EXE-8** Rollback runs as a compensation phase of the same workflow, restoring `before` values for successfully written items. For a create the inverse operation is a delete of the same identifier field, for a delete a create that restores the manifest's `fields` only (ADR 0071). The workflow accepts a rollback request until a configured window after execution ends (ADR 0042). A plan step (CS-9) can be rolled back only when no later step of its plan has started executing, or every later step that did is `rolled_back`; otherwise the request is refused as not rollbackable with `plan_order`, decided in the request's transaction under the plan's lock so a later step cannot start meanwhile (ADR 0074).
- **EXE-9** Use child workflows or continue-as-new for change-sets above a configured item count.
- **EXE-10** Define workflow versioning rules (patch IDs, lifecycle, mandatory replay tests against recorded histories) so that workflows waiting for approval survive a deployment; a patch may be deprecated no earlier than the approval expiry period plus the longest execution time after its deployment, and removed only once those executions have left retention (ADR 0006).
- **EXE-11** The executor is accessed through an interface with a Temporal implementation and an in-memory implementation for tests.
- **EXE-12** A manifest may declare `verify_after`: `after_seconds` (0 to 86400, default 0), `every_seconds` (10 to 3600, default 30), `timeout_seconds` (10 to 604800, default 600, not below `after_seconds`, at most 1000 looks), 1 to 20 `checks` with the predicates of CS-3 and up to 5 own `lookups` (OPS-7); `{ record }` means the record as read at the look through `read_before` (without the scope filter for a create or delete). When the batch loop ended with nothing left, the change-set stays `executing` and every item that ended `written` is looked at, first after `after_seconds` and then every `every_seconds`, in chunks of the batch size: an item whose checks all hold is `confirmed`; otherwise it stays pending with the first failing check's code, or `verify_read_failed` when a read of its chunk failed, was truncated or was short. At `timeout_seconds` after the last batch pending items become `unconfirmed` with that code, or `verify_timeout`; a cancel during verification makes them `unconfirmed` with `verify_cancelled`, and the change-set ends with the status its items give. An unconfirmed item stays `written`, can be rolled back and makes the change-set `completed_with_errors`. Verification only reads upstream; per item only a status and a code are kept, never a record or lookup value (SEC-3), and one audit event `changeset.verification` records how it ended and the counts (ADR 0073).
- **EXE-13** A plan step (CS-9) above step 1 starts only when the step before it is `completed` (all written, none failed, verification confirmed); otherwise the start is refused with `plan_blocked` and the step stays `prepared` or `approved`. When a step ends `completed`, its workflow starts the next step if that one is `approved`, through the same executor start the approver's start uses (start checks, limits, move to `executing`, wake), with the stored submission's identity, the role's limits from the worker's current configuration and actor `system`, before the finished step's rollback window opens; a next step that is only `prepared` is not started, even when it needs no approval. A limit refusal, any other refusal or an unreachable Temporal leaves the next step `approved` (a refusal audited by the start as today) and the finished step settles as usual; the requester or the approver can start it later. A step that ends in any other status (`completed_with_errors`, `failed`, `cancelled`, `rejected`, `expired`, `rolled_back`) stops the plan: every later step stays blocked until it expires or is cancelled (ADR 0074).

### 5.9 Widgets and trusted pages

- **UI-1** Each view is one React component, receiving data and actions as props, built twice: as a single-file MCP Apps bundle whose entry uses `@modelcontextprotocol/ext-apps/react`, and as a route in `web` whose entry uses the REST API.
- **UI-2** Views: change-set preview, change-set detail, approval, execution progress and result, credential entry, audit search.
- **UI-3** Preview shows statistics, an item table with before and after, exclusion controls, export, and submit.
- **UI-4** Result shows counts, per-item errors, and a rollback action when the manifest allows it.
- **UI-5** Credential entry and audit search are available only as trusted pages, never as widgets (ADR 0042).
- **UI-6** Widgets call back only to the platform's own tools, through the host (`tools/call` over the MCP Apps bridge), make no direct network requests (empty `_meta.ui.csp`), and adopt the host client's theme from the standard MCP Apps CSS variables with their own fallbacks. The server cannot tell a widget-originated tool call from a model-originated one, so every call is authorized server-side on its own.
- **UI-7** Pages show only data the logged-in user is allowed to see under policy.

### 5.10 Audit

- **AUD-1** Record: authentication events, tool-list requests, policy decisions, tool calls, change-set transitions, approvals, per-batch execution results, configuration loads, credential changes.
- **AUD-2** Each event carries actor, client identifier, correlation ID, and the change-set ID when applicable.
- **AUD-3** The audit table is append-only. Each row stores the hash of the previous row. Rows are chained in insertion order by a single sealer shortly after they are written; verification reports the unsealed tail (ADR 0042).
- **AUD-4** Redact credentials and fields marked sensitive in manifests before writing.
- **AUD-5** Provide a verification command that checks the hash chain.
- **AUD-6** Provide filtered search on the audit page and JSON Lines export.
- **AUD-7** Apply a configurable retention period, implemented as archive-then-delete with a chain anchor.

### 5.11 Configuration

- **CFG-1** Load roles, connections, operations, presets, limits and notification targets from a directory of YAML files.
- **CFG-2** Validate on load with precise file, path and reason for each error. Invalid configuration is rejected as a whole and the previous one stays active.
- **CFG-3** Provide a CLI: `validate`, `diff` against the active configuration, `apply`, `test-connection`, `explain` for a user and operation.
- **CFG-4** Record each applied configuration with its content hash in audit.
- **CFG-5** Secrets never appear in configuration files; files reference credentials by name.

### 5.12 Notifications

- **NTF-1** Send approval requests and execution results to configured channels: email and Slack-compatible webhook.
- **NTF-2** Notifications contain a summary and a link, never item data.
- **NTF-3** Channel delivery failures are retried and do not block the workflow.

## 6. Security and non-functional requirements

### 6.1 Security

- **SEC-1** Authorization is enforced server-side on every tool call and every page request. Nothing relies on the client hiding a control.
- **SEC-2** Upstream credentials are encrypted at rest with envelope encryption and support key rotation. They are decrypted only inside adapter calls.
- **SEC-3** Credentials, tokens and fields marked sensitive never appear in logs, audit, tool results, workflow history or notifications.
- **SEC-4** Temporal payloads use a data converter with encryption (the `_tracer-data` header carries only W3C trace context and is not encoded; ADR 0047).
- **SEC-5** Content returned from upstream systems is treated as data. It is never interpreted as instructions, and widgets render it escaped.
- **SEC-6** Tool descriptions from upstream MCP servers are not passed to clients unreviewed. Operations use descriptions from configuration or presets.
- **SEC-7** Each upstream credential is expected to carry least privilege in the upstream system. The connection test reports the scopes it can detect.
- **SEC-8** Approval, rollback and credential actions require a fresh authenticated session and are protected against CSRF. The only exception is an approval made in a widget under APR-8, which is authenticated by the approver's access token on the MCP endpoint. A rollback is therefore confirmed on the trusted page; the `rollback_changeset` tool links to it (ADR 0042).
- **SEC-9** A change-set executes only when its stored hash matches the hash recorded on the approval.
- **SEC-10** Rate limits apply per user and per service account at the MCP endpoint.
- **SEC-11** The repository ships a security policy, dependency scanning in CI, and automated tests for every denial path in section 5.3.

### 6.2 Reliability

- **NFR-1** A restart of `api`, `worker`, PostgreSQL or Temporal at any point does not lose, duplicate or corrupt a change-set execution.
- **NFR-2** All upstream writes are safe to retry.
- **NFR-3** `api` is stateless and can run as multiple instances behind a load balancer.
- **NFR-4** `worker` can run as multiple instances on the same task queue.
- **NFR-5** Database schema changes ship as forward migrations that run on start.

### 6.3 Performance

- **NFR-6** Policy evaluation and tool-list construction add no upstream calls and complete from in-memory configuration.
- **NFR-7** Preparation and execution of large change-sets stream items in pages; no step loads a whole change-set into memory.
- **NFR-8** Item tables in widgets and pages are paginated server-side.

### 6.4 Operability

- **NFR-9** A standard installation starts with one Docker Compose command and requires no Kubernetes and no proprietary cloud service.
- **NFR-10** Health and readiness endpoints exist for `api` and `worker`.
- **NFR-11** Traces propagate one correlation ID from the MCP call through workflow, activities and upstream calls.
- **NFR-12** Metrics cover tool calls, policy denials, change-set counts by status, batch latency, upstream error rates.
- **NFR-13** Backup and restore of PostgreSQL is documented, including the Temporal database.

### 6.5 Quality

- **NFR-14** `packages/core` is covered by unit tests without infrastructure.
- **NFR-15** Integration tests run against real PostgreSQL and a Temporal test server.
- **NFR-16** An MCP conformance suite runs against the endpoint in CI.
- **NFR-17** Each preset ships contract tests that run against a recorded or sandbox upstream.
- **NFR-18** Public interfaces of `connector-sdk` and the configuration schema are versioned; breaking changes require a major version.

## 7. Implementation sequence

Work proceeds in eleven phases, numbered 0 to 10. Each phase ends in a runnable system and has acceptance criteria that must pass before the next phase starts.

### Phase 0. Technical spikes

Resolve the five unknowns that shape the architecture. Output is a short written finding per spike and throwaway code.

1. MCP SDK: stateless Streamable HTTP, a different tool list per authenticated user, a Tasks-based long-running call.
2. Authorization: an MCP client completes the OAuth flow against Keycloak and reaches a protected endpoint. Repeat with Claude Desktop and ChatGPT.
3. MCP Apps: one widget renders in Claude Desktop and ChatGPT, calls a tool back, and falls back to a URL elsewhere.
4. Temporal: a workflow waits for a signal, runs three activities, and survives a code change deployed while it waits.
5. Magento 2 REST: schema import size, the bulk endpoints for product updates, and an idempotency approach for writes.

Acceptance: each spike has a pass or fail result and a chosen approach. A failed spike changes the affected section of this document before Phase 1.

### Phase 1. Skeleton

- Monorepo with all packages from section 3, lint, type-check, test runner, CI.
- Docker Compose with `api`, `worker`, PostgreSQL, Temporal, Keycloak.
- `api` serves a stateless MCP endpoint with one hard-coded tool (MCP-1, NFR-3); `worker` runs one trivial workflow.
- Database migrations that run on start (NFR-5) and the base schema for audit.

Acceptance: a fresh clone starts with one command; an MCP client calls the tool; the call appears in audit; CI is green (the CI script passes when run locally; a hosted run is confirmed after the first push).

### Phase 2. Identity, configuration and policy

- Token validation, protected resource metadata and default client registration in the bundled realm (AUTH-1, AUTH-2, AUTH-3, AUTH-7, AUTH-8).
- Configuration loader, schemas and CLI `validate` (CFG-1, CFG-2, CFG-5).
- `PolicyEngine` with grants, scope, denied fields (POL-1, POL-2, POL-3, POL-7, POL-8).
- Per-user tool list (MCP-2) and argument validation (MCP-3).
- Server-side enforcement on every tool call, evaluated from in-memory configuration, with `core` unit-tested without infrastructure (SEC-1, NFR-6, NFR-14).

Acceptance: two users in different groups see different tool lists; an out-of-scope call is denied and audited with the matching rule; an invalid YAML file is rejected with file and path.

### Phase 3. Connections and read operations

- Credential storage and the credential entry page (SEC-2, UI-5, AUTH-5).
- OpenAPI adapter (CONN-2, CONN-3, CONN-5, CONN-6, CONN-7).
- Operation registry with enable and override (OPS-1, MCP-9).
- Direct execution path for `read` operations with audit (MCP-4, AUD-1, AUD-2).
- First cut of `presets/magento2-catalog` with read operations.
- Redaction of credentials and tokens, upstream content handled as data, and detected scopes in the connection test (SEC-3, SEC-5, SEC-7).

Acceptance: with a Magento sandbox attached, a content-manager role searches products of an allowed brand through an AI client and is denied for another brand; the credential is absent from logs and audit.

### Phase 4. Change-sets

- Manifest schema and engine (OPS-2, OPS-3, OPS-4).
- Preparation: resolve targets, read current state, compute diff, store items, hash (CS-1 to CS-4, CS-6), streaming items in pages (NFR-7).
- Built-in tools `list_my_operations`, `get_changeset` and `cancel_changeset` (MCP-8; `submit_for_approval` follows in Phase 6 and `rollback_changeset` in Phase 8).
- Executor interface with the in-memory implementation (EXE-11).
- Add `update_content` with manifest to the Magento preset.

Acceptance: preparing an update for a brand produces a stored change-set with correct before and after values and makes zero write calls to Magento; the same input produces the same hash.

### Phase 5. Execution on Temporal

- Operation workflow and activities (EXE-1 to EXE-7, EXE-9, EXE-10).
- Idempotent batch writes and drift detection (EXE-4, CS-7, NFR-2).
- Multiple `worker` instances on one task queue (NFR-4).
- Limits and re-evaluation at execution (POL-4, POL-6).
- MCP Tasks integration (MCP-7).
- Encrypted Temporal payloads (SEC-4).

- Pulled forward (ADR 0027): the no-approval slice of `submit_for_approval` (MCP-8) and the declarative bulk route of OPS-6 used by the Magento preset.

Acceptance: a change-set of several thousand items executes to completion; killing `worker` mid-run and restarting it produces no duplicate and no missing writes; an item changed upstream after preparation is skipped and reported.

### Phase 6. Approvals and trusted pages

- Approval rules, routing, separation of duties, chains, decision channel (POL-5, APR-1 to APR-4, APR-8).
- Workflow approval wait with expiry.
- Approval and change-set detail pages (APR-5, APR-6, APR-7, UI-2, UI-7).
- Step-up authentication and hash verification (AUTH-6, SEC-8, SEC-9).
- Notifications (NTF-1 to NTF-3).
- Built-in tool `submit_for_approval` (MCP-8), server-side pagination of item tables (NFR-8), and handling of the `destructive` risk class.

Acceptance: a change-set above the role threshold cannot execute without approval; the requester cannot approve it; an approval older than the expiry is refused; a tampered change-set fails the hash check.

### Phase 7. Widgets

- Shared component library and dual build (UI-1, UI-6).
- Preview, progress and result widgets (UI-3, UI-4, MCP-5, MCP-6).
- Item exclusion and export (CS-5, CS-8).

Acceptance: the full flow from request to result works inside an MCP Apps host with widgets (verified locally with the reference host on the ext-apps `AppBridge`; Claude Desktop and ChatGPT implement the same host protocol; ADR 0041), and inside a terminal client with text and links only.

### Phase 8. Rollback and audit hardening

- Rollback as compensation (EXE-8) and `rollback_changeset` tool, wired to the result view's rollback action (UI-4; ADR 0035).
- Hash-chained audit, verification command, search page, export, retention (AUD-3 to AUD-7).
- Configuration `diff`, `apply`, `explain` and audit of applied configuration (CFG-3, CFG-4).
- Observability (NFR-10 to NFR-12).

Acceptance: rolling back a completed change-set restores every written item to its prior value; altering one audit row makes verification fail; one correlation ID links the MCP call, workflow and upstream calls in traces.

### Phase 9. Generic MCP upstream and second system

- MCP upstream adapter with pinning (CONN-1, CONN-4, SEC-6).
- `write_opaque` handling: approval with raw arguments, no diff.
- Preset loading as versioned packages (CONN-8) and the code-operation path in the connector SDK (OPS-5, OPS-6).
- A second preset for a different system, built only through public interfaces.
- Service accounts (AUTH-4).

Acceptance: a third-party MCP server is attached through configuration alone and its tools obey role grants; a changed upstream tool description disables the operation; the second preset required no change to `core`, `api` or `worker`.

### Phase 10. Release readiness

- Security test suite for all denial paths, rate limits (SEC-10, SEC-11).
- Conformance, contract and restart tests in CI (NFR-1, NFR-15 to NFR-17).
- Installation, configuration, preset authoring and backup documentation (NFR-9, NFR-13).
- Versioning policy for SDK and configuration schema (NFR-18).
- Contribution guide, license headers, example configuration.

Acceptance: a newcomer with only the public documentation installs the system, attaches a Magento sandbox, configures one role, and completes an approved bulk update. The walkthrough is done in a clean clone by someone with no knowledge of the repository, reading only the public documentation as rendered; every unclear place found is fixed, and the run is repeated until one passes with no blocking finding (ADR 0059).

## 8. Out of scope and open items

### Out of scope

- A chat interface, a model, or an LLM gateway.
- A general-purpose admin panel for roles and connections.
- A catalog or marketplace of third-party MCP servers.
- Acting as an identity provider or OAuth authorization server.
- Direct database access to business systems.
- Multi-tenancy inside one installation.
- RAG, knowledge indexing and organizational memory.
- A skills or prompt registry beyond per-operation descriptions.
- Attribute-based policies with arbitrary conditions. The `PolicyEngine` interface allows adding them later without changing callers.
- A visual workflow builder.
- Sandboxed execution of untrusted third-party code. Presets are declarative; code operations are installed by the operator as trusted packages.

### Open items to resolve in Phase 0

- [x] Confirm the TypeScript MCP SDK supports stateless mode, Tasks and per-request tool lists at protocol version 2026-07-28. Confirmed with the v2 SDK; Tasks is an extension whose server side `api` implements (ADR 0003).
- [x] Decide between MCP-Nest and the SDK used directly, based on dynamic per-user tool registration. The SDK is used directly (ADR 0003).
- [x] Confirm Keycloak satisfies the client registration method that Claude Desktop and ChatGPT expect. Claude via CIMD, ChatGPT via a pre-registered public client; ChatGPT's own CIMD attempt is rejected by Keycloak 26.8.2 (ADR 0004). Observed on 2026-11-16 with claude.ai web and ChatGPT web; claude.ai also needs `offline_access` to be grantable (ADR 0009). The Claude Desktop app itself was not used.
- [x] Record which MCP clients render MCP Apps widgets and which need the URL fallback. Recorded in ADR 0005: Claude and ChatGPT render the widget and its Submit call reaches the server, observed on 2026-11-16; the other clients are recorded from vendor documentation; Claude Code and plain MCP clients need the URL fallback.
- [x] Confirm Magento 2 REST schema import size and select the bulk endpoints the preset will use. The schema is Swagger 2.0, about 640 KB; the preset imports a filtered subset and uses `POST /async/bulk/V1/products` (ADR 0007).
- [x] Choose the idempotency approach for Magento writes, since the API has no native idempotency key. Read-before-write against the stored `before` and `after`, plus a persisted upstream bulk identifier per batch (ADR 0007).
- [x] Define the Temporal workflow versioning convention and write it into the contribution guide. Defined in ADR 0006 (`patched` / `deprecatePatch` plus replay tests) and written into CONTRIBUTING.md and docs/conventions/temporal-workflows.md.
