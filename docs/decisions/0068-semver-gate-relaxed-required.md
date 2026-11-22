# ADR 0068: The semver gate judges a key removed from `required` additive

- Status: Accepted
- Date: 2026-11-22

## Context

The semver gate (NFR-18) compares the committed public surface reports line by line and calls every
removed line breaking. The configuration schema report prints each `required` array one key per
line. Making a configuration key optional removes its line from the array, which the gate read as a
removal and answered with a demand for a new major version. The change is the mirror of a newly
required key: every configuration that was valid stays valid, so the guide's rule that a change which
widens what is accepted is additive applies. The gate already judges the newly required key breaking
(`narrowing` in `tooling/versioning/semver-gate-lib.mjs`); it had no counterpart for the removal.

## Options considered

1. Leave the gate alone and bump the major version whenever a key becomes optional.
2. Parse the schema and compare the required sets.
3. Keep the line comparison and forgive the removed lines of a `required` frame.

## Decision

Option 3. In `compare`, a removed entry is dropped from the removed lines and counted as an added
(additive) change when it belongs to a JSON `"required": [` frame: a key line, the closing `]`, or the
`"required": [` opener of an array that disappears altogether. The object that held the array must
still exist in the new report. A `.d.ts` report has no such frame and is unaffected.

Removing the key from `required` and from `properties` stays breaking, because the removed property
lines are removed lines outside the `required` frame and are still judged as before. The whole object
removed stays breaking for the same reason: its parent frame is gone, so the rule does not apply.

## Consequences

- Making a configuration key optional is a minor change, as the guide says for any widening.
- The gate still sees names and shapes, not meaning. A key that becomes optional but that a consumer
  of the schema relied on being present (a generated type, for example) is left to review.
- A removed key whose property schema stays is additive; the property remains accepted.

## Verified

2026-11-22: unit tests in `tooling/test/semver-gate.unit.test.ts` cover a key removed from a
multi-line `required` array (additive with a minor bump, failing without one), the same key removed
from `properties` too (breaking), a `required` array removed with its object present (additive), the
whole object removed (breaking) and a removed line in a `.d.ts` report (breaking).
