# ADR 0073: Verify-after stage

- Status: Accepted
- Date: 2026-11-22

## Context

Mandate's only check after a write is the writer's immediate re-read of the written fields, inside
the batch activity (CS-7). An upstream can answer `ok`, return the new value at once, and still not
have taken the change into effect: a queue consumer, an indexer, a cache, or a second system that
syncs from the first. A script-driven catalog workflow waits and then looks again, often somewhere
else. Mandate ends `completed` before any of that can be seen, so the requester is told a change
worked that may not have.

The stage has to be generic and declared in the manifest, like the preparation checks (CS-3) and
lookups (OPS-7, ADR 0072), and it must not change how a change-set that started before the upgrade
replays, nor let a write happen that would not have happened without it.

Naming: the manifest key is `verify_after`; code and storage say **verification**. It is unrelated
to `ExecutionResume.verified` (the execution guard ran) and to the writer's immediate re-read.

## Options considered

Where the verify stage lives:

1. **Inside `executing`, before the final status.** After the last batch the workflow keeps the
   change-set `executing`, waits on workflow timers and runs verify rounds, and only then calls
   `finishExecution`. No new status, so the lifecycle table, the database check, the MCP task
   mapping and every badge stay as they are. The final status then already tells the truth, and
   the result notification goes out once, after verification.
2. **A new status `verifying`.** Clearer on screen, but a status touches the lifecycle, the status
   check constraint, tool output schemas, the task mapping, the widgets and the pages, and an old
   client meets a status it does not know.
3. **After the final status, in the rollback-window phase.** No effect on the status at all; the
   change-set reads `completed` and may turn out unconfirmed an hour later, after the requester was
   already told it worked.

## Decision

Option 1: the least surface, and the status is never wrong. Its cost: a change-set that is
verifying still counts against `concurrent_executions` (POL-4) and cannot be rolled back until
verification ends. Both are documented.

- **Manifest.** Write operations with a manifest (not opaque ones) may declare:

  ```yaml
  verify_after:
    after_seconds: 60        # 0..86400, default 0: wait before the first look
    every_seconds: 30        # 10..3600, default 30: between looks
    timeout_seconds: 900     # 10..604800, default 600: from the end of the last batch
    lookups: { <name>: <same shape as a preparation lookup> }   # at most 5, own namespace
    checks: [{ code, title?, require: [<predicate>, ...] }]     # 1..20, same predicates as CS-3
  ```

  The loader refuses `timeout_seconds < after_seconds` and more than 1000 looks
  (`(timeout_seconds - after_seconds) / every_seconds <= 1000`). A check has at most 10 predicates.
  `code` follows the CS-3 rule and is not a built-in exclusion reason, a fixed verification code or
  a code of the operation's preparation `checks` **(call: one code, one meaning per operation)**.
  Lookups follow the OPS-7 rules; `{ lookup: ... }`, `found` and `not_found` in a verify check refer
  to `verify_after.lookups` only, and a preparation check never sees them.
- **References.** In a verify check: `{ after: f }` and `{ before: f }` (the stored item),
  `{ arg: name }`, `{ lookup: name, field: f }`, and `{ record: f }`, which here means the record as
  read *now* through the manifest's `read_before`, with the change-set's arguments, the ids and the
  field list, as the writer's verify read does. For an update a record outside the call's scope is
  no record; a create or delete reads existence without the scope filter, and a page shorter than
  its total or holding a record without a readable identifier is an incomplete read (ADR 0071).
  Lookup keys: `{ target: true }`, `{ after: f }`, `{ before: f }`, `{ record: f }`. The current
  records are read only when a check or a lookup key uses `{ record }`.
- **Which items.** Every item that ended `written`, including `already_applied`. Items that were
  failed, skipped or excluded are not verified.
- **When it runs.** Only when the batch loop ended with nothing left (`done`). A run that ended on
  the failure threshold, a cancel, a writer or an executor error is not verified **(call)**.
- **A look (round).** For the items still pending, in chunks of the manifest's batch size: read the
  current records when needed, read the lookups, evaluate the checks in order. All hold: the item
  is `confirmed`, for good. Otherwise the item stays pending and remembers the code of the first
  failing check. A failed, truncated or short read is not an error of the round: the chunk's items
  stay pending with the fixed code `verify_read_failed` **(call)**. Any other error is not caught
  and the activity retries. A deleted record that is absent is simply no record, so
  `{ absent: { record: f } }` holds.
- **The end.** No item pending: done. `timeout_seconds` reached: every pending item becomes
  `unconfirmed` with its remembered code, or `verify_timeout` when it has none. A cancel request
  during verification stops it: pending items become `unconfirmed` with `verify_cancelled`, and the
  change-set ends with the status its items give, not `cancelled`, because every write already
  happened **(call; amends EXE-7)**.
- **Final status.** `completed` needs no failed and no unconfirmed item. Otherwise
  `completed_with_errors`; `failed` keeps today's rule (every included item failed). An unconfirmed
  item stays `written` and can be rolled back; nothing is rolled back automatically.
- **Storage.** `change_item.verification_status` (`pending | confirmed | unconfirmed`, NULL when
  never verified), `verification_code`, `verification_round`; `change_set.verification_first_at`
  and `verification_until`, written once when verification begins (first look `after_seconds`, the
  deadline `timeout_seconds` after the end of the last batch) so that a retry and a continued run
  agree on the deadline. Item status, `before`, `after` and the hash are untouched.
  `stats.verification = { pending, confirmed, unconfirmed }`, present once verification began.
- **Workflow.** Behind `patched('changeset-workflow-verify-after-<date>')`, and only when
  `beginExecution` answered `verifyAfter: true` (absent in every old history, so an execution
  without `verify_after` records no marker): `beginVerification`, wait until the first look, then
  repeat { `verifyBatch` until the round is through; stop when nothing is pending or the deadline
  passed; wait `every_seconds` or a wake }, then `finishVerification` and `finishExecution('done')`.
  The waits are workflow timers, so a worker restart loses nothing. Continue-as-new as today; a
  continued run finds the stored deadline and round and goes on.
- **Read-only.** Verification activities only read upstream and retry safely: a confirmed item is
  never un-confirmed, and no verification path calls a writer.
- **In-memory executor** (EXE-11) runs the same core functions with an injected sleep.
- **What leaves (SEC-3).** Per item: a status and a code. Never a lookup value or a record value:
  they are read and dropped, and never reach a stored item, a log, the audit, a tool result, a page
  or workflow history. One audit event `changeset.verification` when verification ends, with how it
  ended (`done`, `timeout`, `cancelled`) and the three counts only.
- **Views.** `get_changeset` and the result view show the three counts; an unconfirmed item shows
  its code and the check's `title`; the progress line reads "Verifying: N of M confirmed".
- **Left out (call).** Re-running the *preparation* checks just before the write is a different
  stage and not part of this one: it would make every batch depend on reads of other connections at
  write time, and CS-7 already refuses a record whose written fields moved.
- **Versions.** Configuration schema and connector SDK 1.3.0, additive (`verify_after` is optional).
  The Magento and Gitea presets do not change **(call)**; the template preset demonstrates it.

## Consequences

- A change-set with `verify_after` reads `completed` only when the effect was seen, after the
  operator's own checks; the requester is told once, after verification.
- A verifying change-set stays `executing`: it holds a `concurrent_executions` slot and cannot be
  rolled back until verification ends, for at most `timeout_seconds`.
- An unconfirmed item is not undone. The change-set ends `completed_with_errors`, and the requester
  or an approver decides whether to roll back.
- A cancel during verification no longer yields `cancelled`: the writes already happened, so the
  status reflects the items.
- Every look adds reads on the write's connection and on each lookup's connection, at most 1000
  looks per change-set; an unavailable upstream during a look keeps items pending instead of
  failing them, until the deadline.
- A change-set without `verify_after` runs exactly as before: no marker, no new activity, and old
  workflow histories replay unchanged.

## Verified

2026-11-22: core unit tests (`verification.test.ts`) cover an item confirmed when every verify check
holds and one naming the first failing check (`shop_price_differs`), a lookup that finds nothing
(`not_in_shop`), a failed (500), truncated or short lookup read and a failed, truncated or short
`read_before` read each making every item of the chunk `verify_read_failed`, a `{ record }` check
reading `read_before` once with its field and the read's template arguments and no lookup, an
update record outside the call's scope read as no record, a deleted record that is gone confirming
`{ absent: { record } }` while one still present in another scope does not, a short page and a
record without a readable identifier on a delete read as incomplete, a `{ record }` lookup key read
from the current record, no `read_before` read without a `{ record }` reference, any other reader
error propagating, the schedule (first look and deadline), and the audit event carrying the end and
the counts and no item data. The writer's existing tests pass unchanged over the shared
current-record read.
