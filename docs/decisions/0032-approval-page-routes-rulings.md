# ADR 0032: Rulings for the approval decision and start routes and the page API

- Status: Accepted
- Date: 2026-11-17

## Context

[ADR 0030](0030-approvals-pages-and-notifications.md) decided how approvals, the trusted approval pages and notifications work in
Phase 6. Building them showed places where the three subsystems (decisions, pages,
notifications) had to agree on an interface, and details of the page routes that ADR 0030 left
open. This record lists those rulings; the notification delivery rulings are in
[ADR 0034](0034-notification-delivery-rulings.md).

The numbering follows the original record: items 2 to 4 are the technical rulings; item 1 did
not concern the system and is omitted.

## Options considered

The decision route's answer when the start after the last approval fails: `409` with the
start's refusal; `200` with the decision's status plus a separate `start` field.

## Decision

2. **`200 { status, start }`** on `POST …/decision`: the approval stands when the start fails,
   so the decision itself succeeded; the start's refusals (`not_approved`, `limit_exceeded`,
   `executor_unavailable`) are `409` on `POST …/start` only.
3. **Page routes:**
   - `forbidden` stays in the error table but no change-set route produces it: a user who may not
     see a change-set gets `404` (UI-7 visibility comes first).
   - The start route's checks (`not_found`, `expired`, `not_approved_status`, `not_permitted`) are
     an api helper `checkPageStart`, audited as `changeset.start`; an expired change-set is refused
     without the lazy expiry write (the workflow timer and the next start or read expire it).
   - The repository, executor and `ApprovalService` are Nest providers shared by the MCP
     handler factory and the page controllers.
   - The approval queue is ordered by the submission time read from the `submission` column and
     filtered by the `(status, awaiting_role)` index; no new migration. The queue's step number
     comes from the round's approvals; expired rows are dropped after the query; rows where the
     viewer decided an earlier step stay listed and the detail page explains the refusal.
   - Adding role `content_lead` changes the CLI's role count in `cli.test.ts`; the Keycloak e2e
     test's expected groups of alice become `['content', 'content-leads']`; `phase-5.sh`'s
     generated configuration sets `required: never` for its 3000-item run.
4. **Across the subsystems:**
   - `transition`'s `extra` carries `notifications?`; the notification producers fill it.
   - `page-api.mjs` subcommands print one line `{"status":<n>,"body":<json>}` and exit 0 when a
     response arrived; the acceptance scripts parse that.
   - The acceptance check "the approver logged in after the submission" reads `approval.auth_time`
     and the change-set's `submission.at`, not audit details.

## Consequences

- A client of `POST …/decision` must read the `start` field to learn whether execution began; a
  successful decision does not imply a started execution.
