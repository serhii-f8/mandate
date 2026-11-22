# ADR 0042: Rollback, audit chain, configuration apply and observability

- Status: Accepted
- Date: 2026-11-18

## Context

Phase 8 delivers rollback as compensation (EXE-8) with `rollback_changeset` (MCP-8) and the
result view's rollback action (UI-4), the hash-chained audit with verification, search, export
and retention (AUD-3 to AUD-7, UI-2, NFR-8), configuration `diff`/`apply`/`explain` with audited
applies (CFG-3, CFG-4, AUD-1), and observability (NFR-10 to NFR-12). The decisions below follow
from [SPEC](../SPEC.md), [ADR 0006](0006-temporal-workflow-versioning.md), [ADR 0011](0011-persistence-package-and-migrations.md), [ADR 0015](0015-configuration-format-and-loader.md),
[ADR 0024](0024-change-set-preparation-and-manifests.md), [ADR 0027](0027-execution-on-temporal.md), [ADR 0030](0030-approvals-pages-and-notifications.md), [ADR 0035](0035-widgets-exclusion-and-export.md), the
[Temporal conventions](../conventions/temporal-workflows.md) and a reading of the code as it stood
before Phase 8.

Points fixed together with the decisions in the table:

- a rollback is requested at most once and a failed rollback is not retried;
- the rollback request describes the workflow before changing state and leaves `rolling_back` for
  the workflow's own final look when the signal cannot be sent;
- the window starts when `openRollbackWindow` runs (no `finished_at` column);
- `inverse_operation` needs the same `id_field` and a superset of fields (loader check), and
  policy is evaluated for the original operation only;
- `beginRollback` returns the next batch number and done batches answer from storage;
- the finished-status guard is new trigger code;
- revisions carry local spec files;
- rollback runs under the current configuration.

Facts from the code that shaped the options:

- `changesetWorkflow` returns as soon as execution finishes; executor and starter use
  `REJECT_DUPLICATE`, so a closed change-set workflow can never run again under its ID.
- `change_batch` has primary key `(changeset_id, batch_no)` and no phase; `change_item.status`
  has a five-value CHECK, and status changes are allowed only while the parent is `executing`
  or `rolling_back` (trigger 0004).
- Items `written` include `already_applied` ones, which this run did not write.
- The lifecycle already has `completed`/`completed_with_errors` → `rolling_back` → `rolled_back`
  | `failed`.
- About 30 audit call sites write through separate pools, some inside long repository
  transactions that also hold `change_set` row locks. `prev_hash`/`hash` exist and are empty.
- Each process reads its own `MANDATE_CONFIG_DIR`; nothing is stored in PostgreSQL; the loader
  already computes a SHA-256 over configuration, preset and spec files.
- No tracing or metrics code; the worker has no HTTP server; the correlation ID is stored on the
  change-set rows but not sent through Temporal or upstream.

## Options considered

| Question | Options | Decision |
| --- | --- | --- |
| "Same workflow" for rollback (EXE-8) | (a) after execution the workflow waits for a rollback request until a rollback window ends, behind `patched()`; (b) a new run under the same workflow ID with `ALLOW_DUPLICATE`; (c) a separate rollback workflow type | **(a)**: literally the same workflow execution, one history per change-set, no change to the start's duplicate protection; the window bounds how long stored `before` values are trusted |
| Rollback window | (a) `changesets.rollback_window_hours`, default 168, 0 disables; (b) unbounded | **(a)**: config schema minor addition (NFR-18) |
| Change-sets finished before Phase 8 | (a) not rollbackable (workflow closed; `rollback.available` false); (b) restart them | **(a)**: `rollback_until` is only set by the patched path |
| Which statuses can roll back | (a) `completed`, `completed_with_errors` only; (b) also `cancelled` and `failed` when execution started and items were written | **(b)**: a cancelled or threshold-failed run is exactly when restoring matters; lifecycle gains `cancelled`→`rolling_back` and `failed`→`rolling_back` |
| Which items are restored | (a) every `written` item; (b) `written` items with no `error` code (this run's writes), not `already_applied` | **(b)**: restoring an `already_applied` item would revert someone else's change |
| Per-item rollback state | (a) new `change_item.status` values; (b) separate columns `rollback_status`, `rollback_error` | **(b)**: the execution result stays readable, the hash line and CHECK on `status` are untouched |
| Rollback batches | (a) add a phase column to `change_batch` and change its primary key; (b) a separate `change_rollback_batch` table with the same fencing | **(b)**: no primary-key change under running workflows; guards copied, not rewritten |
| Rollback writer | (a) a second writer; (b) `ManifestBatchWriter` with a direction (`forward` / `reverse`), reverse swaps `before`/`after` for classification, write and verify | **(b)**: one read-before-write, drift and bulk path (CS-7, EXE-4) |
| `inverse_operation` | (a) refuse; (b) reverse writes through the named operation's bulk binding | **(b)**: the loader already checks the operation (same connection, `write`); the writer only changes binding |
| Authority for rollback (SEC-8) | (a) `rollback_changeset` rolls back with the access token; (b) the tool checks eligibility and returns the page link; the rollback itself is `POST /api/v1/changesets/:id/rollback` with a fresh session and CSRF | **(b)**: SEC-8 names rollback; its only exception is a widget approval under APR-8. Same pattern as a submit that needs approval |
| Who may roll back | (a) the requester, with the operation still allowed by policy for the stored arguments (POL-6-like); (b) also approvers; (c) a new role flag | **(a)**: smallest authority; approval of a rollback is not required because it restores values that existed before and is drift-checked; recorded as a known gap to revisit |
| Hash chain under concurrent writers (AUD-3) | (a) `BEFORE INSERT` trigger chaining under an advisory transaction lock; (b) insert unchained, a single sealer assigns `chain_pos`, `prev_hash`, `hash` in insertion order; (c) per-writer chains | **(b)**: (a) serialises every transaction that audits and can deadlock with the `change_set` row locks repository transactions take before their audit insert; (b) keeps inserts as they are, and a late-committing row simply gets a later position. The unsealed tail is bounded (sealer every 2 s) and reported by `verify` |
| Row hash | (a) SQL `sha256`; (b) TypeScript in `core`, canonical JSON with tag `mandate.audit.v1`, `ts` read as UTC text with microseconds | **(b)**: one pure function shared by sealer and verifier, unit-tested without infrastructure (NFR-14) |
| Retention (AUD-7) | (a) CLI only; (b) worker job by `audit.retention_days`, plus the CLI to run it now | **(b)**: archive JSON Lines plus manifest into `MANDATE_AUDIT_ARCHIVE_DIR`, then one transaction inserts an `audit_anchor` and deletes the sealed prefix; the trigger permits that delete only with `SET LOCAL mandate.audit_retention = 'on'` and only up to the newest anchor |
| Sensitive fields (AUD-4) | (a) `manifest.sensitive_fields`, redaction by key in one `redactAuditDetails` applied by every `AuditLog` implementation; (b) per-call-site care | **(a)**: defence in depth; details carry no values today and must stay so |
| Audit page access (SEC-1) | (a) new role flag `view_audit: true`; (b) any logged-in user sees own events | **(a)**; default off, denial audited |
| Audit search as a widget (UI-1) | (a) page only; (b) widget too | **(a)**: audit content must not flow through the model's connection; SPEC UI-5 is extended to name audit search next to credential entry |
| Active configuration (CFG-3, CFG-4) | (a) files per process as today, `apply` writes files; (b) the active configuration is the newest row of `config_revision` (YAML texts plus hash), `apply` inserts it and every process loads it from PostgreSQL; files bootstrap an empty table; (c) files are the source, PostgreSQL only gates hashes | **(b)**: SPEC section 2 places the configuration snapshot in PostgreSQL; every instance runs the same configuration (NFR-3, NFR-4); apply is one transaction; diff is exact |
| Propagation of an apply | (a) SIGHUP per process; (b) `LISTEN mandate_config` plus a 30 s poll, SIGHUP still re-reads | **(b)** |
| A revision a process cannot load identically (preset versions differ) | (a) run it anyway; (b) keep the previous configuration, audit `config.load` with outcome `error`, readiness reports it | **(b)**: CFG-2's "previous stays active"; a process with no configuration is not ready |
| `diff` output | (a) text diff of files; (b) per entity (connections, operations, roles, notifications, settings) added / removed / changed with the changed keys, plus old and new hash | **(b)** |
| `explain` input | (a) groups given on the command line (`--groups`); (b) IdP lookup | **(a)**: the platform never queries the IdP (AUTH, [ADR 0014](0014-token-verification-and-realm-bootstrap.md)) |
| Tracing library | (a) own spans with `@opentelemetry/api`; (b) `@temporalio/interceptors-opentelemetry` 1.25.0 (client, activity, workflow interceptors, workflow span sink) with OTel SDK 1.30.1 and exporters 0.57.2 | **(b)**: parent-child spans from the MCP call through the workflow to activities; Verified below |
| Trace export | (a) OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, no-op otherwise; Jaeger 2.23.0 as an optional Compose profile `observability` | **(a)** |
| Metrics | (a) OTel metrics with the Prometheus exporter on `/metrics` of a separate, unpublished port per process; (b) OTLP push | **(a)**: scrape-able without a collector; the port is not published by Compose by default |
| Worker health (NFR-10) | (a) worker HTTP server on `MANDATE_WORKER_HTTP_PORT` (8081) with `/healthz`, `/readyz` (database, configuration, Temporal worker running), `/metrics`; (b) none | **(a)**; Compose gains a worker healthcheck |

## Decision

As in the table. The specification changed with this decision:

- SPEC EXE-8: rollback is available until a configured window after execution ends.
- SPEC MCP-8 and SEC-8: `rollback_changeset` checks and links; the rollback happens on the
  trusted page.
- SPEC AUD-3: rows are chained in insertion order by a sealer; the unsealed tail is reported.
- SPEC UI-5: audit search, like credential entry, is a trusted page only.
- SPEC section 4: the lifecycle names `cancelled`/`failed` → `rolling_back` after execution.

## Consequences

- `changesetWorkflow` gets its first patch, `changeset-workflow-rollback-20261118`, with new
  fixtures; workflows stay open for the rollback window.
- New tables `change_rollback_batch`, `audit_anchor`, `config_revision`; new columns on
  `change_item`, `change_set` and `audit_event`; trigger bodies replaced by new migrations only.
- `mandate config apply` becomes the way to change a running configuration; SIGHUP re-reads the
  active revision, not the files. Acceptance scripts that edit files mid-run switch to `apply`.
- The configuration schema (NFR-18) gains `changesets.rollback_window_hours`, `audit`
  (`retention_days`), `roles[].view_audit`, and `manifest.sensitive_fields`: a minor version.
- New dependencies: OTel 1.30.1 / 0.57.2 line and the Temporal interceptor, pinned.

## Verified

- `@temporalio/interceptors-opentelemetry@1.25.0` (npm, `npm pack`, read 2026-11-18,
  `lib/plugin.ts`, `src/workflow/index.ts`, `src/instrumentation.ts`): it depends on
  `@opentelemetry/api ^1.9.0`, `core`/`resources`/`sdk-trace-base ^1.25.1`. Its
  `OpenTelemetryPlugin` installs a client interceptor, activity inbound/outbound interceptors,
  `workflowModules` and an injected `exporter` sink, also for replay workers. Context travels in
  the Temporal header `_tracer-data`, written with the payload converter.
- `@temporalio/common@1.25.0` `internal-non-workflow/payload-visitor.ts`: headers are visited
  unless `skipHeaders` is set, so the encrypting codec (SEC-4) also encodes the trace header.
- npm on 2026-11-18: the latest `^1` of `@opentelemetry/sdk-trace-base`, `sdk-trace-node`,
  `resources`, `core`, `sdk-metrics` is 1.30.1; `exporter-trace-otlp-http`,
  `exporter-prometheus` 0.57.2 depend on exactly those 1.30.1 packages.
- Docker Hub on 2026-11-18: `jaegertracing/jaeger` 2.23.0 (2026-11-05).
- Not verified at the time of this decision: that every committed history in
  `apps/worker/test/workflow-histories/` replays with the plugin's workflow interceptors
  installed, and that one trace links api, workflow and activity spans with the codec on. The
  fallback, if replay failed, was option (a) for workflows (activity and client interceptors
  only). The later experiment is recorded in [ADR 0047](0047-trace-header-plaintext-w3c-context.md): all histories replay and the
  workflow interceptors are kept. ADR 0047 also corrects the conclusion above about the trace
  header: the SDK sets `skipHeaders`, so `_tracer-data` is not encoded by the codec.
