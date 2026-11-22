# ADR 0074: Plans

- Status: Accepted
- Date: 2026-11-22

## Context

A script-driven catalog workflow runs steps in order: create the records, then link them, then
publish them. In Mandate each step is its own change-set, with its own hash, approval and workflow
(EXE-1), and nothing stops the second from starting before the first has finished, or after it
failed. A requester who prepares three change-sets today has to watch the first and start the next
by hand, and an approver who approves the second early lets it run against a catalog the first has
not changed yet.

The ordering has to keep what an approval means: an approver approves exactly one sealed hash
(POL-5, SEC-9). It must not restructure the workflow, so a change-set that started before the
upgrade replays unchanged, and it must not let a write happen that would not have happened without
it.

## Options considered

How steps are ordered:

1. **A gate on prepared change-sets, plus automatic start.** A plan is an ordered list of
   change-sets the requester already prepared. Each keeps its own hash, approval and workflow. The
   platform refuses to start a step before its predecessor is `completed`, and starts an approved
   step by itself when the predecessor completes.
2. **Late preparation.** A plan holds call templates; step n+1 is prepared after step n ran.
   Handles a step that reads what the previous one wrote, but an approver would approve step 2
   before its diff exists, or the plan would stop for a new approval at every step, which the
   client can already do today by calling the next tool.
3. **A parent workflow that owns the steps.** Breaks EXE-1 (one workflow per change-set, ID =
   change-set ID) and duplicates expiry, cancel and rollback handling.

## Decision

Option 1, because the approval still covers exactly a sealed hash and no workflow is restructured.
Its limit, stated in the guide: a step whose *preparation* depends on an earlier step's effect
(update a record the earlier step creates) cannot be prepared up front; fold it into the create, or
prepare it after the earlier step ran, outside a plan. A step whose stored `before` went stale is
skipped as `drift` by CS-7, as today.

- **A plan** is `{ id, title, requester, created_at }` (table `plan`) and an ordered list of 2 to 20
  change-sets. Each change-set carries `plan_id` and `plan_step` (1-based), both set or both NULL,
  unique per plan (CS-9).
- **`create_plan({ title, changesets: [<id>, ...] })`** is a new tool, denied unless the caller is
  the requester of every listed change-set. Every change-set must be `prepared`, not expired, in no
  plan, and listed once; the title is 1 to 200 characters without control characters. One
  transaction locks the listed change-sets in ID order, so two calls over overlapping lists queue
  instead of deadlocking and exactly one of them takes a shared change-set. Refusals are fixed
  codes: `not_found` (also a malformed ID), `not_requester`, `not_prepared`, `already_in_plan`,
  `duplicate_step`, `too_few_steps`, `too_many_steps`; a refusal writes nothing. One audit event
  `plan.created` carries the plan ID and the number of steps, never the title (SEC-3).
- **Membership is outside the hash.** It is written only by `create_plan` and the derive handover
  below, and the update guard of migration `0017_plans` refuses any change to `plan_id` or
  `plan_step` once the change-set has left `preparing` or `prepared` **(call: order is enforced by
  the platform, not sealed into each hash, so no hash version 3)**.
- **Approval is per change-set, unchanged (POL-5).** Steps may be submitted and approved in any
  order. The approval view names the plan, the step and the predecessor's status.
- **The gate (EXE-13).** `startExecution` refuses a step above 1 with `plan_blocked` unless the step
  before it is `completed` (so: all written, none failed, verification confirmed, ADR 0073). The
  predecessor is read in the start transaction, after the status and approval checks and before the
  limits, so a blocked start changes nothing and writes no audit row. A refused step stays
  `prepared` or `approved`. The same check runs in the execution guard.
- **Automatic start.** When a step ends `completed`, its workflow starts the next step if that one is
  `approved`; a next step that is `prepared` and needs no approval is **not** started, because
  nobody confirmed it **(call)**. The start uses the stored submission's identity and the role's
  limits from the worker's current configuration, exactly as the approver's start does today, with
  actor `system`; then it wakes the next step's workflow. A limit refusal leaves the step
  `approved`, audited; the requester or the approver can start it later through the existing
  paths. Behind `patched('changeset-workflow-plan-advance-<date>')`, and only when the finished
  change-set is in a plan.
- **How the next step is started.** The worker's `advancePlan` activity calls the same executor
  `start` the approver's start uses (start checks, limits, move to `executing`, wake), so there is
  no second start path.
- **A step that does not complete stops the plan.** `completed_with_errors`, `failed`, `cancelled`,
  `rejected`, `expired` or `rolled_back` on a step leaves every later step blocked **(call: no
  override in 1.x)**. They expire, or the requester cancels them.
- **Rollback order (amends EXE-8).** A step can be rolled back only when no later step of its plan
  has started executing, or every later step that did is `rolled_back` (`plan_order` otherwise).
- **Deriving (amends CS-5).** A change-set derived from a plan step that is still `prepared` takes
  the source's place in the plan in the transaction that seals it (its move to `prepared`); the
  source leaves the plan **(call)**. Derived from a source in any other status, or when its
  preparation fails, it is outside the plan and the source keeps its slot. The item copy moves
  nothing, so a derivation that never completes never holds a step. The sealing transaction locks
  the `plan` row `FOR NO KEY UPDATE`, then both change-sets in ID order, and moves the slot only if
  the source is still `prepared` in the same plan.
- **Expiry** is per change-set, as today. An approved step waiting behind a long predecessor can
  expire; the guide says to size `expire_after_hours` for the whole plan.
- **Views.** The plan title reaches the approvers of any one step of the plan and every
  `review_changeset` caller who may view a step. `get_changeset` and the change-set pages carry
  `plan: { id, title, step, of, steps: [{ step, id, operation, status }] }`. A sibling's row shows
  only those four values; opening it needs the viewer's own right to it.
- **Versions.** Plans change no versioned surface of the connector SDK or the configuration schema.
  Migration `0017_plans` is forward-only: a new table, two nullable columns with their check and
  unique index, and the update guard redefined from its `0016` body.

## Consequences

- A requester can prepare the steps of a multi-step change up front, have each approved on its own,
  and rely on the platform to run them in order, one after the other, without watching.
- An approval still means one sealed hash. Approving step 2 early is safe: it cannot run until
  step 1 is `completed`.
- A step that ends anything but `completed` stops the plan with no override; the later steps expire
  or are cancelled, and a new plan is prepared after the cause is fixed.
- A step cannot be prepared from an earlier step's results; such work stays outside a plan.
- A long plan can outlive an approved step's expiry; `expire_after_hours` has to cover the whole
  plan.
- Rolling back a step waits for every later step that started to be rolled back first.
- A change-set outside a plan starts, executes and rolls back exactly as before, and old workflow
  histories replay unchanged.
- Every transaction that needs plan-wide exclusion locks the `plan` row `FOR NO KEY UPDATE` first,
  then the `change_set` rows in ID order; `FOR NO KEY UPDATE` does not conflict with the `KEY SHARE`
  lock a foreign-key check takes, but does conflict with itself.

## Verified

2026-11-22: core unit tests (`plan.test.ts`) cover the shape refusals (one step, 21 steps, a
repeated ID), the gate (step 1 always; a later step only after a `completed` predecessor, not after
`completed_with_errors`, `executing`, `failed`, `cancelled`, `rolled_back` or `approved`; a missing
predecessor blocks) and the rollback order. The repository contract, run against PostgreSQL and the
in-memory store, covers `createPlan` in list order with one `plan.created` row, every refusal with
nothing written, atomicity with the audit row, two concurrent calls sharing a change-set (exactly
one succeeds), the `plan_blocked` start that writes nothing and comes before the limits, the start
after the predecessor completed, and the derive handover when the derived change-set is sealed from
a `prepared` step, its absence when the copy alone ran, when the preparation failed, when the audit
append failed and when the source was cancelled first. The integration test of migration `0017` shows the guard refusing a membership
change on `pending_approval`, `approved`, `executing`, `completed`, `cancelled` and `expired` rows
and admitting it on `preparing` and `prepared` ones, the check and unique index, and the `0016`
verification rule still in force. The contract also covers the rollback order in the request transaction (`plan_order` while
a later step that started is not `rolled_back`, admitted once it is) and a start of step 2 racing a
rollback request of step 1 (`Promise.all`, eight rounds): before both took the plan lock first, the
PostgreSQL run let both succeed; with it, exactly one does. The execution guard refuses a step whose
predecessor is not `completed` as `policy_denied`.

2026-11-22, automatic start: on the Temporal test server with PostgreSQL
(`plan-workflow.int.test.ts`), a completed step starts the approved next one through the worker's
`advancePlan` and the `TemporalExecutor` start, with actor `system` on the `executing` transition and
the requester's identity on the execution request; a step that ends `completed_with_errors` calls no
`advancePlan`; a `prepared` next step is not started and runs after a later approval and the
approver's start; a next step over its role limit stays `approved` with one `limit_exceeded`
decision while the finished step settles through its rollback window; with `verify_after` the next
step stays `approved` until verification confirmed; an `advancePlan` that fails all five attempts
leaves the next step `approved` and the finished step `completed`; a change-set outside a plan
records no marker. Fixtures `plan-advanced`, `plan-advanced-traced` and `plan-not-advanced` replay
with every older history unchanged. The Temporal `Client` of the worker runs on its
`NativeConnection` (`@temporalio/worker` 1.26.0 `lib/connection.d.ts`: "can be used to power
`@temporalio/client`'s Client objects") with `clientDataConverter` over the worker's keys.
