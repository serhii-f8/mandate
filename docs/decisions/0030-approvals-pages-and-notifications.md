# ADR 0030: Approvals, trusted approval pages and notifications

- Status: Accepted
- Date: 2026-11-17

## Context

Phase 6 adds approval rules and decisions (POL-5, APR-1–APR-4, APR-8), the approval and
change-set detail pages (APR-5–APR-7, UI-2, UI-7, NFR-8), step-up and hash verification (AUTH-6,
SEC-8, SEC-9), notifications (NTF-1–NTF-3), the full `submit_for_approval` (MCP-8) and the
`destructive` risk class. Phase 5 left open multi-role precedence for approval mode and limits,
how the approval reaches the workflow, and whether the worker re-checks the approval mode at
start.

## Options considered

1. **Subsystem division:** one; three (decisions; pages; notifications), which meet at the
   repository's decision methods and the outbox table.
2. **How an approval reaches the workflow:** a new approval signal with the decision as payload;
   the existing data-free wake plus state in PostgreSQL, with `api` starting execution through
   the executor after the last approval.
3. **Return with comment (APR-4):** a new terminal status; reuse `rejected`; back to `prepared`
   (resubmit starts a new round).
4. **Chains (APR-3):** keep `approver_role` and add a list; replace it with `steps: [{ role }]`.
5. **Multi-role precedence:** strictest approval among all roles that would allow the call; the
   allowing rule's role (first matching grant), as limits already do.
6. **Step-up (AUTH-6):** `acr` levels in Keycloak; `auth_time` age only; `auth_time` age plus
   "logged in after the approval was requested".
7. **Worker re-check of POL-5:** none (trust `api`); re-check approval requirement and approval
   rows in `beginExecution`.
8. **Tasks for submissions that need approval:** a task that lives until execution ends; a
   normal result.
9. **Notification delivery:** inline in the producer; a Temporal workflow per notification; an
   outbox table drained by a dispatcher loop in the worker process.
10. **Email transport:** a hand-written SMTP client; nodemailer; a hosted mail API.
11. **Short expiries for tests and acceptance:** a test-only switch; a minutes key; a fractional
    `expire_after_hours` (minimum one minute).

## Decision

1. **Three subsystems** (decisions; pages; notifications).
2. **Wake plus state.** Decisions are rows in `approval`; the last approval moves the change-set
   to `approved` and `api` calls `executor.start`, which already accepts `approved` and
   signals-with-start the waiting workflow. The workflow's command sequence does not change, so
   no `patched()` call is needed; new replay fixtures are recorded with the current code. This
   keeps EXE-2 (signals carry no data) and [ADR 0027](0027-execution-on-temporal.md) decision 4 (api moves to
   `executing`).
3. **Return → `prepared`** with the comment; resubmission starts a new round and the old round's
   approvals no longer count. SPEC section 4 gains the transition. A change-set is still never
   edited: a changed request is a new change-set.
4. **`steps: [{ role }]`** replaces `approver_role` (1–5 steps), objects so later per-step fields
   are additive. Each step needs a different person, none of them the requester.
5. **The allowing rule's role** decides scope, limits and approval: one rule explains every
   outcome, and the operator controls precedence by grant order (visible in audit and, from
   Phase 8, `explain`).
6. **`auth_time` age plus "after the request"**, page channel only: an approver must have logged
   in after the current round was submitted and within `step_up_max_age_seconds`. A session
   that was merely fresh before the request does not count, so a step-up is always a new login.
   No `acr` mapping ([ADR 0019](0019-credential-vault-and-trusted-page-sessions.md) decision 3).
7. **Re-check in the worker**: `beginExecution` refuses (`approval_missing`) a change-set that the
   current configuration says needs approval but whose round lacks approvals with the recomputed
   hash. Defence in depth against any `api` path that starts without approval.
8. **A normal result** for submissions that need approval: they wait for people, possibly for
   days; the client follows with `get_changeset`. Submissions without approval keep their task.
9. **Outbox and dispatcher**: inserted in the producer's transaction (no lost or phantom
   notifications), drained with `FOR UPDATE SKIP LOCKED` leases by any worker (NFR-4), retried
   with backoff; no new workflow type (EXE-10 cost) and no effect on change-set state (NTF-3).
10. **nodemailer** over SMTP, Mailpit as the development sink (NFR-9: no hosted service).
11. **Fractional `expire_after_hours`**, minimum 1/60: a real configuration value, no test-only
    code path.

Also: destructive operations with a manifest take the change-set path and always need approval
and step-up (default 120 s), never in a widget; the widget decision tool `decide_changeset` is
declared `_meta.ui.visibility: ["app"]` and listed only to approvers of roles with
`allow_widget: true`; webhook URLs are credentials with the new scheme `webhook_url` (connector
SDK 0.4.0, additive) entered on the credential page; the approval page shows the hash and states
the count, and the server checks both (APR-6, SEC-9).

Further rulings:

- **An approved change-set that did not start** (a limit, Temporal down, a crash between the
  decision and the start) stays `approved` until expiry; the requester starts it with
  `submit_for_approval`, or a holder of the last step's role with "Start execution" on the page
  (fresh session and CSRF; audited `changeset.start` when refused). No sweeper and no workflow
  change.
- **`destructive` is a label on a normal manifest update**: the change-set invoker and the
  worker's writer selection accept it like `write`; no delete semantics in Phase 6.
- **Approval-request notifications go to the step role's own `notify.approval_requests`**;
  `notify.results` of the requester's role receives decisions and execution results.
- `submit_for_approval` checks the `hash` argument on every path; expiry counts from creation, so
  a returned and resubmitted change-set keeps its deadline; one visibility function serves every
  page route.

## Consequences

- SPEC section 4 changes (lifecycle: `pending_approval → prepared` on return; approval rows carry
  the hash, count and channel).
- Configuration schema: `approval.steps`, `approval.step_up_max_age_seconds`, role `notify`,
  webhook `allowed_hosts`/`allow_private_network`, fractional `expire_after_hours`;
  `approver_role` is gone (no release yet, [ADR 0015](0015-configuration-format-and-loader.md) decision 8).
- The development realm gains group `content-leads` (role `content_lead`) and user `dave`; alice
  joins `content-leads` too, so the acceptance proves that separation of duties, not a missing
  role, refuses her own approval.
- `content_manager` switches from `required: never` to `above_threshold` in the development
  configuration; earlier acceptance scripts that execute must stay under the threshold or use
  their own override.
- Group membership changes after submission are not seen at execution (no user directory): POL-6
  re-checks the submitted groups against the worker's current configuration.

## Verified

2026-11-17.

- **MCP Apps:** `@modelcontextprotocol/ext-apps` 2.0.4, `dist/src/spec.types.d.ts:619-640`:
  `McpUiToolMeta.visibility?: ("model" | "app")[]`, default `["model","app"]`, `"app"` = "Tool
  callable by the app from this server only". Hosts enforce it ([ADR 0008](0008-approval-in-widgets-is-opt-in.md)); the server
  refuses widget decisions that are not permitted regardless.
- **Keycloak step-up:** the re-login with `prompt=login&max_age=0` raises `auth_time`
  ([ADR 0019](0019-credential-vault-and-trusted-page-sessions.md) experiment with Keycloak 26.8.2); the Phase 6 acceptance re-checks it by
  logging in again before the approval and comparing `auth_time` with the submission time.
- **Temporal:** no new API is used; the workflow's existing wait (`condition` with the expiry
  timeout, wake signal) is exercised by the new integration tests and replay fixtures.
