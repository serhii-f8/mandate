# Temporal workflow conventions

Binding for every change under `apps/worker/src/workflows/`, `packages/temporal/src/contract.ts`,
activity signatures and `apps/worker/test/workflow-histories/`.

- Workflow code is deterministic: no I/O, no wall-clock time, no randomness, no
  environment access, no Node built-ins, no imports from NestJS, Drizzle or adapters.
  Everything non-deterministic happens in activities.
- One workflow per change-set, workflow ID = change-set ID (EXE-1). Workflow inputs,
  signals and activity arguments carry identifiers only; item data is read from
  PostgreSQL inside activities (EXE-2).
- Activities are idempotent and safe to retry (EXE-4, NFR-2).
- **Versioning (EXE-10).** Any change that adds, removes, reorders or retypes a command
  (activity, timer, child workflow, signal, wait) in a workflow type that has ever been
  deployed, or changes an activity's name or argument shape, goes behind `patched(id)`.
  "It is only waiting at the signal" is not an exemption: the change is undetected
  there, and the waiting workflow silently runs new code. For a restructure too large
  to branch, add a new workflow type (`<name>V2`) and keep the old one registered
  until its last execution closes. Activity bodies need no patch.
- **Patch IDs:** `<workflow-type-kebab>-<what>-<yyyymmdd>`, one per change, never
  reused or renamed. Each carries a comment "remove not before <date>".
- **Live patches** of `changesetWorkflow` (each with its "remove not before" date in
  `apps/worker/src/workflows/changeset.ts`): `changeset-workflow-rollback-20261118` (EXE-8),
  `changeset-workflow-verify-after-20261122` (EXE-12).
- **Lifecycle:** `patched` → `deprecatePatch` only when no execution started before the
  patched deployment is open, and never earlier than change-set expiry plus the
  longest execution time after that deployment → removal only after those executions
  have left retention. Never skip a step, and never deploy `deprecatePatch` while
  workers with the pre-patch code still run. Once an execution has passed a patch
  marker, code without the `patched()` call cannot replay it, so check rollback before
  deploy. The `deprecatePatch` and removal steps were not exercised in the spike;
  the first real use must be tested before it is relied on.
- **Replay test is a CI gate:** `Worker.runReplayHistory` over every committed history
  in `test/workflow-histories/<workflowType>/*.json`. Required fixtures per type: one
  parked at each wait after at least one activity, one completed per code path, one per
  live patch marker, one failed or compensated. A change that adds a command adds a
  fixture recorded with the new code; old fixtures are never regenerated to make a
  replay pass. The one exception: when a patch is removed, fixtures containing its
  marker are deleted or regenerated in the same change.
- **Activity results the workflow reads are part of its contract.** `changesetWorkflow`
  builds its activity options from the `inspect` result (`tuning`). Once the type is on
  `main`, a new field there must have a default in workflow code (an old history replays
  with the old result) or go behind `patched()`.
- Workflow types that have never been on `main` may have their fixtures re-recorded freely;
  from the first merge on, the rules above apply (`changesetWorkflow` from Phase 5 on).
- Worker Deployments with pinned workflows are not used ([ADR 0006](../decisions/0006-temporal-workflow-versioning.md)).
- Never send signal or terminate input from the Temporal CLI or UI: the codec refuses
  plaintext payloads and the workflow can no longer be replayed ([ADR 0027](../decisions/0027-execution-on-temporal.md) addendum).
- Payloads go through the encrypting data converter (SEC-4). Nothing sensitive in
  workflow history, search attributes or workflow IDs (SEC-3).
- Large change-sets use child workflows or continue-as-new (EXE-9) and stream items in
  pages (NFR-7).
