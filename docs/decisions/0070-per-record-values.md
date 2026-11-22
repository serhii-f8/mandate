# ADR 0070: A write can carry per-record values

- Status: Accepted
- Date: 2026-11-22

## Context

A manifest write takes one `values_arg` object that applies to every target. Changing two products to
two different names takes two calls and two approvals, or a write the platform cannot diff. Callers
want one change-set whose items each carry their own values, with the same before and after, drift
check, verification and rollback per item.

The field policy (POL-3) and the approval field rules (POL-5) read the keys of the `fields_arg`
object. For records, the keys of interest are those inside each record.

## Options considered

1. Keep `values_arg` and add a second argument holding per-target overrides.
2. Let `values_arg` accept either an object or an array.
3. A second manifest key, `records_arg`, as the alternative to `values_arg`.

## Decision

Option 3. `manifest.records_arg` names a required top-level array property of the input schema. Exactly
one of `values_arg` and `records_arg` is declared; the loader reports anything else as `must declare
exactly one of values_arg and records_arg` at `manifest`. The check is not a schema refinement, so
a later action that takes no values can exempt itself in one place. With `records_arg`, `ids_arg` and
`selector` are not allowed (`is not allowed with records_arg`): the records name the targets.

- The array items are closed objects: `type: object`, `properties` within `id_field` plus `fields`,
  `additionalProperties: false`, `id_field` in the items' `required` and typed `string` or `integer`.
  Closing the items means no key is dropped silently.
- `fields_arg` defaults to `records_arg`, and may only equal it.
- Policy: for such an operation `touchedFields` answers the union of the records' keys without
  `id_field`, in first-seen order, so one denied field in one record denies the call and the
  identifier is never a touched field. An array that mixes records with anything else is
  `unreadable`, which the existing fail-closed rules handle. Without an `idField` argument an array of
  objects stays `unreadable`, as before: only the manifest's records argument is read this way.
  Approval field rules route on the same fields. `closedFieldNames` answers the item properties
  without `id_field`, so a rule naming a field the records cannot carry is refused at load.
- Versions: the configuration schema and connector SDK move to 1.2.0 and the product to 1.2.0. The
  schema change is additive: `values_arg` leaves the manifest's `required` list, which the semver gate
  judges additive (ADR 0068). A configuration written for 1.1 loads unchanged.

Option 1 adds a second route for the same intent; option 2 makes one argument's shape depend on its
value and defeats the closed-schema check.

## Consequences

- A preset may use `records_arg`; the Magento and Gitea presets do not change.
- Preparation, items, drift, verify and rollback for records are the subject of later changes of this
  release (the core model already carries `recordsArg`).
- A caller that sends a call with two records for one target is refused at preparation
  (`duplicate_targets`), never resolved by order.

## Verified

2026-11-22: unit tests load a records manifest to `recordsArg` without `valuesArg` and refuse each
malformed case (both keys, neither, `ids_arg`, `selector`, a non-array or optional argument, open or
non-object items, a property outside `id_field` and `fields`, a missing or wrongly typed identifier, a
foreign `fields_arg`). A policy test with 500 records, one carrying `price`, denies with `denied_field`
and `price`, allows without it, never reports the identifier, and passes an allow-list of `name`.
The approval routing test sends a records call with one `price` to the field rule, and a load test
refuses field rule names outside the item properties. `semver-gate` reports the configuration and
preset reports additive and the SDK report unchanged.
