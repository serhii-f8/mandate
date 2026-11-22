# ADR 0006: Temporal workflow versioning

- Status: Accepted
- Date: 2026-11-16

## Context

EXE-1 runs one Temporal workflow per change-set. EXE-10 requires versioning rules so that a
workflow waiting for human approval (possibly for days, up to the approval expiry) survives a
deployment (NFR-1). Temporal re-executes workflow code against the recorded event history
("replay") whenever a worker has no cached copy of the workflow, which is always the case after a
deployment replaces the worker process. If the code now emits a different command sequence than the
history records, the workflow task fails with a non-determinism error. A Phase 0 experiment
(`spikes/4-temporal`) measured what actually happens, using SDK `@temporalio/*@1.25.0` against
Temporal server 1.32.2.

## Options considered

1. **`patched()` / `deprecatePatch()`** (in-code versioning, single code line, all workers run the
   newest code). Verified: old histories replay on the old path, new executions take the new path,
   waiting workflows survive process replacement, replay tests catch violations. Cost: branch code
   accumulates until old workflows close; needs discipline (a replay test per patched change).
2. **Worker Versioning / Worker Deployments with PINNED workflows** (side-by-side builds, a
   workflow stays on the build it started on). Verified on the dev server: a PINNED workflow stays
   on `b1` and never runs the incompatible `b2` code; but it is stranded if `b1` workers are not
   running, so every build must stay up until its last pinned workflow closes (here: up to the
   approval expiry). Temporal's own decision guide recommends it for long workflows that use
   continue-as-new, and recommends AUTO_UPGRADE + patching for long workflows that do not. It also
   needs server >= 1.29.1 and extra deployment tooling (set-current, drain detection). It does not
   remove the need for patching for AUTO_UPGRADE workflows.
3. **New workflow type names** (`operationWorkflowV2`; callers start the new type, old type code is
   kept until old executions close). Always safe, no marker bookkeeping, but copies code and needs
   the starter to choose the type; it does not version already-running workflows.
4. **Combinations.** Patching as the baseline, new type names as the escape hatch for changes too
   large to branch, Worker Deployments as a possible later addition once the operational model
   exists.

## Decision

Use **option 4 with patching as the mandatory baseline**:

- All behaviour changes to a workflow that can already have recorded history use `patched()` with a
  unique patch ID. Removal follows `patched` -> `deprecatePatch` -> removal.
- Breaking restructures use a new workflow type name; the old type stays registered until its last
  open execution closes.
- A replay test against committed recorded histories is a required CI gate for every workflow
  change.
- Worker Deployments (PINNED) are not adopted now. They are recorded as a verified, workable
  alternative for a later phase if blue/green operation of workers becomes desirable; they add
  run-time obligations (keep every build alive for up to the approval expiry) that Phase 1 has no
  need for.

The full rules are in the versioning convention,
[docs/conventions/temporal-workflows.md](../conventions/temporal-workflows.md).

## Consequences

- A deployment during a pending approval is safe provided the rules are followed. The failure mode
  of breaking them is observable and recoverable: the workflow stays RUNNING and its workflow task
  fails repeatedly with `[TMPRL1100] Nondeterminism error`; redeploying the previous code lets the
  workflow continue (verified). It does not fail the workflow, but approvals stall until fixed.
- A waiting workflow that has not yet executed the patched line takes the NEW path when it resumes
  (`patched()` is true outside replay). Patching therefore does not freeze a waiting workflow on
  old logic; only already-recorded steps stay old.
- Old branches live for at least the approval expiry plus the longest execution time. The code
  carries that cost; a removal checklist is part of the convention.
- Recorded histories become test fixtures that must be maintained (captured from tests and from
  production).
- Activities are not replayed: their implementation can change freely, but their name and arguments
  are part of the recorded history.
- Nothing in SPEC needs to change for the decision itself.

## Verified

- Date 2026-11-16, `spikes/4-temporal/run.sh`: 15/15 `check.mjs` assertions and 4/4
  `check-versioning.mjs` assertions pass.
- Stack: Docker image `temporalio/temporal:1.10.1` (CLI 1.10.1, Server 1.32.2, UI 2.56.4), SDK
  `@temporalio/{client,worker,workflow,common,activity}@1.25.0`, Node v22.20.0.
- Docs read: https://docs.temporal.io/develop/typescript/versioning ;
  https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning ;
  https://docs.temporal.io/worker-versioning ;
  https://docs.temporal.io/develop/typescript/best-practices/testing-suite (replay) ;
  https://hub.docker.com/r/temporalio/temporal (image). Typings in
  `node_modules/@temporalio/workflow/lib/workflow.d.ts` (`patched`, `deprecatePatch`),
  `worker/lib/worker.d.ts` (`runReplayHistory`), `worker/lib/worker-options.d.ts`
  (`workerDeploymentOptions`), `common/lib/worker-deployments.d.ts` (`VersioningBehavior`).
- Not experimentally shown (`unverified`): the `deprecatePatch` removal step and its interaction
  with old histories, the production visibility query for open-workflow replay, and any behaviour
  of a production (non-dev) server or Postgres persistence.
