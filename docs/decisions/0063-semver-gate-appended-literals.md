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

A second rule covers a union printed over several lines (`AuthSettings`, `SecretMaterial`). Appending
a variant turns the closing `};` of the last variant into `} | {` and adds the new variant's lines
and a new `};`. The line rule saw the old `};` as removed, although no line of the union changed
meaning, so the first rule was not enough. The gate tolerates exactly that: a removed `};` that
closes the last variant of a root `type` declaration that was already a union of type literals (the
old report has a `} | {` in that declaration), paired with an added `} | {` in the same frame. A
single type literal that becomes a union stays breaking, because code reading one of its members
(`x.json`) stops compiling; so does a nested `};` that becomes `} | {` inside an interface member or
inside a nested member of a root type. Every other line of the union is compared as before, so a
removed or changed member or variant, a variant inserted before the last, and a changed closing line
of an interface or class stay breaking.

## Consequences

- Appending a credential scheme is a minor change, as the guide says.
- The exhaustive-switch caveat of the guide applies and is left to review: a consumer that
  switches over the list without a default can stop compiling.
- The literal rule sees one line; a literal list printed one element per line is judged as before
  (an appended element is an added line). A union of type literals printed over several lines is
  covered by the second rule only when it was already a union.

## Verified

2026-11-22: unit tests in `tooling/test/semver-gate.unit.test.ts` cover tuple and union lines
(appended, reordered, removed, renamed and non-literal changes, and a report whose only change is
an appended element) and appended union variants against an `AuthSettings`-shaped fixture, with the
breaking counter-cases: a removed, inserted, trimmed or changed variant, an interface closing line,
a single type literal that becomes a union, and a nested `};` that becomes `} | {` inside an
interface member and inside a nested member of a root union.
