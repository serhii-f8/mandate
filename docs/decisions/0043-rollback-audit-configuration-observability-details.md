# ADR 0043: Rollback, audit, configuration and observability details

- Status: Accepted
- Date: 2026-11-18

## Context

[ADR 0042](0042-rollback-audit-configuration-observability.md) decides how Phase 8 builds rollback, the audit chain, configuration apply and
observability. Building its four parts settled smaller points that ADR 0042 left open, and a few
where the existing code disagreed with the first wording. This record lists the ones that span
more than one part, the names the parts share, and the audit ruling R3 that the code cites.

## Options considered

For each point the first wording was weighed against the existing code.

| Question | Options | Decision |
| --- | --- | --- |
| Tool argument name | `changesetId` / `changeset_id` (every built-in tool) | `changeset_id` |
| Temporal unreachable on the rollback page route | 503 / 409 `executor_unavailable` (the other page routes) | 409 |
| Where a rollback failure code goes | `error_status` (it is the integer upstream-status column) / `error_code` | `error_code`: `rollback_writer_error`, `rollback_executor_error`, `rollback_hash_mismatch`, `rollback_workflow_closed` |
| Acceptance trace check | `RunWorkflow` span while the workflow is open / after it closes | the span is exported when the workflow closes (the rollback window keeps it open), so group 4 checks `StartWorkflow` and the `prepare` activity spans first, then cancels the change-set and checks `RunWorkflow` |
| Loading a revision | a new in-memory loader / write the revision's validated files to a private temp directory and use the unchanged directory loader | temp directory: same hash by construction, no change to the spec-file interface |
| Audit action list | union type / `AUDIT_ACTIONS` array with the type derived | array (the search route validates `action` against it); `config.apply` and `config.load` are added to it |

## Decision

As in the table. Shared names:

- Rollback activities `openRollbackWindow`, `beginRollback`, `rollbackBatch`, `finishRollback`;
  `ChangeSetRecord.rollbackUntil`, `rollbackRequest` (with `correlationId`).
- Patch `changeset-workflow-rollback-20261118`, remove not before 2027-06-23 (recompute from the
  real deployment date).
- `ConfigurationStateSource.state()` → `ConfigurationState` (`active` with `revision: string |
  null` and `hash`, `none`, `configuration_mismatch`); `WorkerRuntime.configuration`.
- Lock keys in `packages/db/src/locks.ts`: `AUDIT_SEAL_LOCK_KEY` "mandate-as",
  `AUDIT_RETENTION_LOCK_KEY` "mandate-ar", `CONFIG_LOCK_KEY` "mandate-cf".
- `connector-sdk` goes one minor up with `RequestInstrumentation` (0.5.0 unless already moved).
- `scripts/acceptance/phase-8.sh` runs `MANDATE_ACCEPT8_GROUPS` (default `1 2 3 4`); a missing
  group is a FAIL.

Audit ruling:

- **R3.** `DrizzleAuditLog` instances built inside `@mandate/db` transactions (vault, outbox,
  change-set repository) apply the key pattern and value shapes but no manifest keys. Their
  details are fixed builders without field values. The api, worker and CLI logs pass the
  configuration's `sensitiveFields`.

## Consequences

- Migration 0013 builds two indexes without `CONCURRENTLY`; inserts wait while they build on a
  large `audit_event` (known gap).
- A process with no active configuration answers 503 `configuration_unavailable` on every api
  route except health, readiness and metrics; the worker waits before polling Temporal.
