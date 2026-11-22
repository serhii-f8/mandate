# ADR 0034: Notification delivery rulings

- Status: Accepted
- Date: 2026-11-18

## Context

NTF-1 to NTF-3 are delivered through a PostgreSQL outbox, a dispatcher in the worker, an
e-mail sender and a webhook sender ([ADR 0030](0030-approvals-pages-and-notifications.md) decisions 9 and 10). ADR 0030 leaves a
number of points open; this ADR fixes them so every part of notification delivery builds on one
set of answers. Related: [ADR 0032](0032-approval-page-routes-rulings.md) (`transition`'s `extra.notifications?`).

## Options considered

Per ruling, the alternative is named in the Decision text. The ones with real alternatives:
attempt counting (claim vs. send), error handling for unknown targets (fail at once vs. retry),
the webhook transport (`createTransport` vs. the egress guards alone), the SMTP test double (an
SMTP server dependency vs. an in-process sink).

## Decision

a. A claim increments `attempts`. A worker that dies after claiming has used up that attempt.
b. Every mark (`sent`, retry, `failed`) is fenced by `attempt` and by `state = 'pending'`; a
   fenced mark returns false and writes nothing.
c. The rows of one claim are sent concurrently: 20 rows x 10 s sequentially would outlive the
   120 s lease.
d. The error codes are a closed list: `channel_unconfigured`, `target_unknown`,
   `credential_missing`, `credential_unusable`, `host_not_allowed`, `egress_denied`, `timeout`,
   `network`, `http_status`, `smtp_rejected`, `internal`. Only these reach `last_error`, audit
   and logs (SEC-3).
e. Every failure, `target_unknown` included, follows the retry schedule
   (`min(30000 x 2^(attempts-1), 3600000)` ms, `failed` after attempt 8); a configuration reload
   may restore the target.
f. A cancelled execution also produces `execution_finished` (status `cancelled`). A change-set
   without a `submission` produces none.
g. Producers dedupe targets; the unique key `(changeset_id, kind, round, step, target)` is the
   backstop.
h. `created_at` and `next_attempt_at` take the application clock at insert, not the database
   clock, so tests with a fake clock are deterministic.
i. Subjects for `approval_decided` and `execution_finished` are fixed. Control characters
   U+0000-U+001F and U+007F in interpolated values become spaces. Webhook text is
   Slack-escaped.
j. The webhook sender reuses `assertEgressAllowed` and `createGuardedLookup` with a synthesized
   `ConnectionSettings` (`baseUrl` = the URL, `extraHosts: []`). It does not use
   `createTransport`, because that refuses non-JSON 2xx bodies and Slack answers `text/plain`
   `ok`.
k. The tests use an in-process SMTP sink in `@aiops/testing` instead of an SMTP server
   dependency.
l. In the worker `AIOPS_PUBLIC_URL` defaults to `http://localhost:8400` and `AIOPS_MAIL_FROM` to
   `aiops@localhost`.
m. `credentialRefs` entries gain `notifications: string[]`.
n. Mailpit lookups by change-set ID in the acceptance scripts do not use the search endpoint; see
   Verified. The fallback is used: list `/api/v1/messages` and fetch each message body.

## Consequences

- Delivery is at-least-once: a worker that dies between the send and the mark causes a second
  send after the lease expires. Accepted for notifications.
- A permanently wrong target costs eight attempts over about 2 hours before it is `failed`.
- The acceptance script is slightly more code (list, fetch, grep) but cannot match the wrong
  message.

## Verified

2026-11-17, plus the UUID experiment on 2026-11-18.

- `npm view nodemailer@10.3.1 version types engines` gave `version = '10.3.1'`,
  `types = './dist/cjs/nodemailer.d.ts'`, `engines = { node: '>=20.0.0' }`.
- Mailpit experiment: `docker run -d -p 127.0.0.1:18025:8025 -p 127.0.0.1:11025:1025
  axllent/mailpit:v1.29.0`, one message sent by raw SMTP, then:
  - `GET /api/v1/messages` gave `{ total, messages: [{ ID, From, To: [{ Address }], Subject,
    Snippet }] }`;
  - `GET /api/v1/message/<ID>` gave `{ Subject, To, Text, HTML }`, `Text` being the plain body;
  - `GET /api/v1/search?query=<word>` matches body text;
  - the image healthcheck is `["CMD","/mailpit","readyz"]`;
  - `/mailpit version` gave `v1.29.0`.
- UUID experiment (2026-11-18, same image, body `Change-set
  3f2c9a10-7b1e-4c55-9d2a-0123456789ab awaits approval wordmarker.`):
  `search?query=<that uuid>` returned `total 1`, also quoted and with a trailing space. But
  `search?query=3f2c9a10-7b1e-4c55-9d2a-0123456789ac` (last character changed, not in any
  message) also returned `total 1`: the search tokenizes the hyphenated value and matches
  parts. So search cannot prove a specific change-set ID. Fallback adopted: list
  `/api/v1/messages`, fetch `/api/v1/message/<ID>` for each and match the exact ID in `Text`.
