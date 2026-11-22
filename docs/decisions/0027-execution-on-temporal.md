# ADR 0027: Execution on Temporal: workflow, writes, Tasks and starting execution

- Status: Accepted
- Date: 2026-11-17

## Context

Phase 5 executes prepared change-sets on Temporal (EXE-1–EXE-7, EXE-9, EXE-10), with
idempotent batch writes and drift detection (EXE-4, CS-7, NFR-2), limits and policy
re-evaluation (POL-4, POL-6), MCP Tasks (MCP-7), encrypted payloads (SEC-4) and several
workers (NFR-4). [ADR 0024](0024-change-set-preparation-and-manifests.md) left open where preparation runs, [ADR 0003](0003-mcp-sdk-and-transport.md) left
open what clients without the Tasks extension (including 2025-era clients) get, and Phase 4 left
open the Magento write mapping, drift detection and the executor's cancel semantics.

## Options considered

1. **Subsystem division:** one; three (workflow and executor; writes; Tasks and the api path).
2. **Where preparation runs:** keep it synchronous in `api`; asynchronously in `api`; a worker
   activity, first step of the change-set's workflow (SPEC section 2).
3. **Workflow shape:** a linear script (prepare → wait → execute); a state-driven loop that
   re-reads the change-set from PostgreSQL after every wake.
4. **Who moves a change-set to `executing`:** `api` inside the executor's `start`; the
   worker's first execution activity.
5. **Large change-sets (EXE-9):** child workflow per chunk; continue-as-new after a configured
   number of items.
6. **How the requester starts execution in Phase 5:** a new built-in tool; `submit_for_approval`
   always starting execution; `submit_for_approval` starting execution only when the allowing
   role sets `approval.required: never`.
7. **Clients without the Tasks extension:** an immediate `preparing` answer; a bounded wait
   that answers like Phase 4 when preparation finishes within it.
8. **Which calls give Tasks to declaring clients:** every call; write calls and
   `submit_for_approval` only; only calls that do not finish quickly.
9. **Bulk write protocol:** Magento-specific code in the worker; a declarative bulk mapping in
   the connector SDK and configuration (part of OPS-6, owned by Phase 9).
10. **Limits accounting:** per role; per user with the allowing role's values. Daily window:
    calendar day; rolling 24 h. Calls per minute: audit table counts; a bucket table.
11. **Codec placement:** in `apps/worker` (api would import an app); `packages/core` (no
    Temporal there); a new package `@mandate/temporal`.

## Decision

1. **Three subsystems** (workflow and executor; writes; Tasks and the api path): they meet only
   at the executor port and the workflow starter.
2. **Preparation runs in the `prepare` activity of `changesetWorkflow`.** `api` creates the
   row (`createChangeSet`) and starts the workflow with ID = change-set ID, `REJECT_DUPLICATE`
   and conflict policy `FAIL`. SPEC section 2 already says this, so no SPEC change; the interim
   arrangement of [ADR 0024](0024-change-set-preparation-and-manifests.md) decision 2 ends. The activity fails `config_changed` after
   five attempts when its configuration hash differs from the one the policy decision used.
   (The original text said `createChangeSet` stores the requester's groups; see the addendum
   below.)
3. **State-driven loop**: lost signals, continue-as-new and races converge on the stored
   status. Signals carry no data (requests live in PostgreSQL).
4. **`api` moves the change-set to `executing`** in the executor's `start`, in one transaction
   with the limit checks and the execution request, then `signalWithStart`s the workflow. The
   worker re-checks hash and policy in `beginExecution`. Phase 6 revisits this for approvals
   that wait inside the workflow.
5. **Continue-as-new** every `changesets.items_per_workflow_run` items (default 2000) or when
   Temporal suggests it. One workflow type keeps one fixture set and one code path.
6. **`submit_for_approval` starts execution when the allowing role sets
   `approval.required: never`** and otherwise answers `approval_required`, leaving the
   change-set `prepared`. Phase 5's behaviour is thereby a subset of the final POL-5 behaviour,
   never an unapproved write that Phase 6 would forbid. The development role
   `content_manager` sets `approval: { required: never }`.
7. **Bounded wait** (`MANDATE_PREPARE_WAIT_MS`, default 20 s): small change-sets answer exactly as
   in Phase 4; large ones answer `preparing` with the change-set ID to follow with
   `get_changeset`. This is MCP-7's "immediate result carrying the change-set ID" with a short
   grace period; MCP-7 is reworded accordingly. 2025-era clients cannot declare the extension
   and get the same fallback (MCP-1).
8. **Tasks for write calls and `submit_for_approval`** whenever the request declares the
   extension; normal results for everything else. Task status is derived from the change-set
   on each `tasks/get`; tasks are owned by the caller's subject; foreign and unknown IDs answer
   `-32602`. `tasks/get`/`tasks/update` are not audited; `tasks/cancel` is.
9. **Declarative bulk mapping** in connector SDK 0.3.0 (`UpstreamMapping.bulk`, `WriteAdapter`),
   manifest `write.carry_fields`, Magento preset 0.3.0. Phase 5 delivers this part of OPS-6
   (bulk route, status route, index mapping); Phase 9 keeps the owner role for the rest
   (per-record writes, key mapping, code operations).
10. **Per user, with the allowing role's values; rolling 24 h; a `rate_bucket` table** with
    fixed one-minute buckets (one upsert per call, works across `api` instances).
11. **`@mandate/temporal`** with a pure `contract` subpath for workflow code.

Also: a failed batch's retry policy is bounded (10 attempts); exhausting it finishes the
change-set `failed/writer_error`. `changesets.failure_threshold` (default 0.5) stops
remaining batches (EXE-5). Item outcome codes are fixed strings (`already_applied`, `drift`,
`gone`, `upstream_rejected`, `upstream_failed`, `upstream_retriable`, `no_outcome`,
`write_mode_unsupported`). An item whose current value already equals `after` counts as
`written` (`already_applied`): the target state holds.

Further rulings:

- The worker's hash and policy re-check sit behind an `ExecutionGuard` port; the executor
  contract harness injects an allow-all guard, the production guard has its own tests.
- A batch row stores its pre-submit plan (every item's classification and the submitted
  order, no values) together with the upstream batch ID, so a resumed batch knows the
  outcomes of items it never submitted.
- Batch attempts are fenced by an `attempt` column claimed with the Temporal attempt number;
  a stale attempt writes nothing upstream or in PostgreSQL. The window of an older attempt
  already inside the submit call stays ([ADR 0007](0007-magento-bulk-and-idempotency.md)).
- The codec refuses unencrypted payloads; the Phase 1 smoke fixture replays with the default
  converter.
- Groups are stored with the execution request only, never at creation.
- A failure-threshold stop ends `failed/failure_threshold`; unattempted items stay `pending`.
- "No duplicate writes" is evidenced twice in acceptance: our batch records and the count of
  Magento bulk operations per SKU since the run started.

## Consequences

- SPEC MCP-1 and MCP-7 are reworded (bounded wait, legacy clients) and SPEC section 7 notes
  what Phase 5 pulls forward; SPEC section 2 stays.
- Phase 4's acceptance keeps passing only if preparation finishes within the wait; its Compose
  override must also attach the worker to the sandbox network.
- The worker now needs the configuration, database, vault and adapter, like `api`.
- `submit_for_approval` exists before approvals do; roles without `approval.required: never`
  cannot execute until Phase 6.
- Residual risks of [ADR 0007](0007-magento-bulk-and-idempotency.md) remain (a crash between the upstream accepting a bulk
  and its ID being recorded can submit the same values twice).

## Verified

2026-11-17.

- **MCP Tasks:** specification text
  https://raw.githubusercontent.com/modelcontextprotocol/ext-tasks/main/specification/2026-07-28/tasks.md
  (read 2026-11-17): per-request declaration under
  `_meta["io.modelcontextprotocol/clientCapabilities"].extensions`; server decides per call and
  may return a normal result to a declaring client; never a task to a non-declaring one
  (`-32021` where a task is required); `failed` only for JSON-RPC errors, tool errors are
  `completed` with `isError`; `tasks/cancel` cooperative with an empty `resultType: "complete"`
  acknowledgement; unknown IDs `-32602`; auth on every task request; unguessable IDs;
  `notifications/tasks` optional. Schemas in `@modelcontextprotocol/ext-tasks@0.2.3`
  `dist/core/v2/schemas.js` (`TaskStatusV2Schema`, `CreateTaskResultV2Schema`,
  `GetTaskResultV2Schema`, `CancelTaskResultV2Schema`). Custom request handlers on the 2.4.0
  low-level server and the instance switch were proven in a Phase 0 experiment
  ([ADR 0003](0003-mcp-sdk-and-transport.md)).
- **Temporal** (`@temporalio/*` 1.25.0, `TestWorkflowEnvironment.createLocal`), throwaway
  experiment (deleted), output:
  `signalWithStart ok` / `second SWS on running wf: ok` (signals the running workflow) /
  `result done n=9 runs=3 hist=27 flaky-attempt-2` (state carried through two continue-as-new
  runs; an activity that stopped heartbeating for 5 s with `heartbeatTimeout: 2s` was retried
  and succeeded on attempt 2) / `query after close {"n":9,"run":3}` /
  `SECRET b64 in history? false false marker true` (payload codec encrypts arguments and
  signal arguments) / with only the client's
  `DefaultFailureConverter({ encodeCommonAttributes: true })`:
  `failure message plaintext in history? true`; with the worker's `failureConverterPath`
  pointing to a module exporting the same converter: `false` / `restart closed id: allowed`
  (the default reuse policy lets a closed workflow ID run again, hence `REJECT_DUPLICATE`).
  Typings: `@temporalio/common` `lib/converter/data-converter.d.ts` (`payloadCodecs`,
  `failureConverterPath`), `lib/converter/payload-codec.d.ts`, `lib/workflow-options.d.ts`
  (`WorkflowIdConflictPolicy`); `@temporalio/workflow` `lib/interfaces.d.ts`
  (`continueAsNewSuggested`), `lib/workflow.d.ts` (`continueAsNew`, `condition`, `setHandler`);
  `@temporalio/client` `lib/workflow-client.d.ts` (`signalWithStart`).
- **Magento bulk:** [ADR 0007](0007-magento-bulk-and-idempotency.md) and a Phase 0 experiment (detailed-status
  `operations_list[].id` = request index, states 1/2/3/4/5, custom attributes in bulk bodies,
  `status` reset hazard). The sandbox recordings of the write path re-verify them in Phase 5.

## Addendum 2026-11-17: the client's failure converter

The experiment's "client-only" configuration put a `failureConverter` field on a plain
`DataConverter` object. In `@temporalio/*` 1.25.0 that field does not exist: the client
loads a plain converter with `loadDataConverter`, which reads only `payloadConverterPath`,
`failureConverterPath` and `payloadCodecs`
(`@temporalio/common/lib/internal-non-workflow/data-converter-helpers.js:50-71`), unless it
receives an already loaded converter (`isLoadedDataConverter`,
`@temporalio/client/lib/base-client.js:30-31`). So the field was ignored, and the
observation stands for the reason that matters: the worker writes workflow failures and
needs `failureConverterPath`. `@mandate/temporal`'s `clientDataConverter` therefore returns a
`LoadedDataConverter` with the encoding failure converter; a unit test proves the client
uses it.

## Addendum 2026-11-17: groups are stored only with the execution request

Decision 2 said `createChangeSet` stores the requester's groups. Correction
([ADR 0029](0029-mcp-tasks-rulings.md) decision 3): groups are stored only with the execution request, never at
creation.

## Addendum 2026-11-17: no inputs from the Temporal CLI or UI

The codec refuses unencrypted payloads (`packages/temporal/src/codec.ts`: anything without
`encoding: binary/encrypted` fails with "payload is not encrypted"). A signal or a terminate
sent with an input (signal input, terminate details) from the Temporal CLI or Web UI carries
that input in plaintext and becomes a history event no worker can decode:

- for an open workflow, the decode runs before the activation
  (`WorkflowCodecRunner.decodeActivation`, `@temporalio/worker` 1.25.0 `lib/worker.js:1113`);
  the error is caught as "Failed to process Workflow Activation" and answered with a failed
  activation (`lib/worker.js:1190-1215`), so the workflow task fails and is retried on every
  attempt: the workflow stops progressing and must be terminated;
- for a terminated workflow, the closing event holds a payload that our client cannot decode
  when it reads the history.

Operators must not send inputs from the CLI or UI. Our only signal (the wake signal) carries no
data: what it wakes the workflow for is stored in PostgreSQL (EXE-2), so there is never a reason
to; a terminate may give a reason (a plain string, not a payload) but never details. This is an
operating rule, not a code change.
