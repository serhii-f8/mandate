# ADR 0063: The semver gate judges an appended literal additive

- Status: Accepted
- Date: 2026-11-22

## Context

The semver gate (NFR-18) compares the committed public surface reports line by line and calls
every changed line breaking. The connector SDK prints `CREDENTIAL_SCHEMES` as a `readonly [...]`
tuple on one line of `api-report.d.ts`. Adding a credential scheme changes that line, so the gate
would demand SDK 2.0.0 and every preset's `^1.0.0` range would stop matching. The versioning guide
already says a new enum value is additive; the gate could not tell a widened one-line list from a
rewritten line.

## Options considered

1. Print the tuple one element per line, so an added element is an added line.
2. Parse the declarations and compare element sets.
3. Keep the line comparison and add one narrow rule for a changed line.

## Decision

Option 3. A removed line and an added line in the same context are one additive change when they
are identical except that the new line has string literals appended to one `readonly [...]` tuple
(`, "c"` directly before the `]`) or to one `|` union (` | 'c'` directly before the `;`).
Everything else on a changed line stays breaking: reordering, insertion before the end, removal,
a differing name, non-literal members. `isAppendedLiteralList` in
`tooling/versioning/semver-gate-lib.mjs` implements the check.

## Consequences

- Appending a credential scheme is a minor change, as the guide says.
- The exhaustive-switch caveat of the guide applies and is left to review: a consumer that
  switches over the list without a default can stop compiling.
- The rule sees one line; a list printed over several lines is judged as before.

## Verified

2026-11-22: unit tests in `tooling/test/semver-gate.unit.test.ts` cover appended, reordered,
removed, renamed and non-literal changes, and a report whose only change is an appended element.
