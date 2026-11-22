# ADR 0071: Change-sets can create and delete records

- Status: Accepted
- Date: 2026-11-22

## Context

A manifest write updates records that exist. Creating a product or deleting one takes an opaque call,
which has no diff, no drift check, no verification and no rollback. The change-set model already
carries items whose `before` or `after` is `null` (absent), so the same machinery can serve both.

The word `kind` already means diff versus opaque in the detail answer and the execution guard, so a
new key needs another name.

## Options considered

1. Two new risk classes or operation kinds, `create` and `delete`.
2. A manifest key `action: update | create | delete`, default `update`.
3. Infer the action from the shape of the call (records without ids is a create).

## Decision

Option 2. Option 1 duplicates the risk classes, which say how dangerous a call is, not what it does;
option 3 makes the meaning of a configuration depend on its call.

- `action` is a fixed node in a preset (`must not be a parameter`), like `records_arg`: an action that
  could differ per binding would defeat the guard below.
- **create** needs `records_arg` (`action create needs records_arg`); the caller supplies the
  identifier. Upstream-assigned identifiers stay out: without a key known before the write there is no
  drift check, no idempotent retry and no verify, so such a call remains `write_opaque`. Scope
  arguments are checked against the new record's own values, so every `scope_args` field must be one of
  `fields` (`must be one of fields for action create`), and `write.carry_fields` is not allowed.
  Its records type `id_field` as `string` (`must type <id_field> as string for action create`): the
  identifier is sent as the normalised string target ID, and a typed identifier is not stored, so an
  integer key would be sent as a string. `required_fields` must be among `fields` (`must be one of
  fields for action create`), since they are checked against the new record's values, and a record
  that carries no field of `fields` (only its identifier) is excluded `missing_data`. A check or
  lookup key that reads the current record (`before`, `record`) is refused on a create, one that reads
  `after` on a delete (`is not available for action <action>`).
  Preparation excludes a record that already exists as `already_exists`. **(call, controller ruling)**
  An `already_exists` item stores the existing record's values as `before` only when that record is
  inside the call's scope; otherwise it stores `before: null`, so a record the requester could not read
  never reaches the item, the approval view or the audit.
- **delete** needs `ids_arg` or `selector`, takes no `values_arg` or `records_arg`, and needs risk
  `destructive` (`action delete needs risk destructive`), so it always needs approval and step-up
  authentication. The item holds the current values of all `fields` as `before` and `after: null`.
- **Existence is read without the scope filter.** **(controller ruling, amends design 2.3)** An update's
  `read_before` passes every scope argument, and an upstream that filters by it answers a record of
  another scope as "not found". For a create that turns a foreign record with the same identifier into
  "absent": the item would be pending as new, and an upsert-style endpoint would rewrite the other
  scope's record. For a delete a target that moved out of scope would read as already deleted. So the
  `read_before` of a create or delete must not reference a scope argument (`must not pass scope argument
  <arg> for action <action>: existence is read without the scope filter`, at
  `manifest.read_before.args.<key>`), and the loader no longer demands one there. The platform checks
  the scope on the returned record instead (every `scope_args` field is in the read's field list and,
  where the read declares its fields, must be one it can return): a create of an identifier that exists
  in another scope is `already_exists` with `before: null`, a delete of a target outside the scope is
  `out_of_scope`; at execution either case is `skipped` with `drift`, and after an `ok` answer a delete
  whose record is still there, in or out of scope, is `failed` with `not_applied`. The selector of a
  delete stays scoped: it only proposes targets.
- **Classifier.** With `null` meaning absent: the current state equals `after` is `already_applied`;
  equals `before` is written; otherwise `gone` when neither side is `null` and the record is missing or
  out of scope, else `drift`. A record that appeared with other values is not overwritten by a create,
  and a record changed since approval is not deleted. After an `ok` answer the state must equal
  `after`; a create still absent or a delete still present ends `failed` with `not_applied`.
- **Records sent.** Update as before; create `{ id_field, ...after }`; delete `{ id_field }` plus
  `carry_fields`.
- **Rollback.** `replay_previous_state` is refused for both (`is not available for action <action>`).
  `inverse_operation` works through the existing swap: the inverse of a create must be an enabled
  `delete` manifest operation of the same connection with the same `id_field`; the inverse of a delete
  an enabled `create` of the same connection whose `fields` cover the delete's. The rollback writes
  with the create's manifest, which carries nothing, so the inverse delete must not declare
  `write.carry_fields` (`must name a delete operation without write.carry_fields: a rollback sends the
  identifier only`). The loader's rule that
  an inverse is a `write` operation accepts `destructive` for the inverse of a create. **(call)**
  Rolling back a delete restores only the manifest's `fields`, not other attributes of the record.
  The inverse of an `update` must itself be an update (`must name an update operation`), so a create or
  delete operation never receives update-shaped records of existing targets.
- **Guard.** The stored action must equal the action of the operation under the current configuration,
  else `policy_denied`, as for diff versus opaque. A change-set stored without an action counts as
  `update`, so a copy derived by an older process from a create or a delete never executes against
  an operation that now creates or deletes. A rollback makes the same comparison when it starts and,
  for `inverse_operation`, also requires the inverse still to undo the stored action (a create's a
  delete, a delete's a create, an update's an update); otherwise it ends failed (`executor_error`),
  as when no rollback writer exists.
- Versions: configuration schema 1.2.0, additive (`action` is optional with a default).

## Consequences

- A configuration that changes an operation's action while change-sets of the old action wait for
  execution makes those change-sets unexecutable (`policy_denied`); they are cancelled or expire.
- Deleting is as safe as the operator makes the `fields`: they are what an approver sees and what
  drift compares, and all that a rollback restores.
- The `read_before` of a create or delete must find a record by identifier whatever its scope; a
  binding that cannot (an upstream read that always filters by scope) cannot serve a create or delete
  safely. "A create never overwrites an existing record" holds only under such a read, and a create
  binding should still refuse an existing identifier upstream (a plain `POST`, not an upsert).
- The Magento and Gitea presets do not change; the template preset demonstrates both actions in a
  later change of this release.

## Verified

2026-11-22: loader tests load a create, a delete and both inverse pairs, and refuse each case above at
its path with its message; a load test refuses `action` as a preset parameter. Guard tests show a
stored `create` refused under an `update` operation, a stored action-less change-set refused under a
`create` and a `delete` operation and accepted under an `update`, and matching actions accepted.
Writer tests send a create through the per-record `POST` binding and roll it back through the
delete operation's binding against the fake catalog, including the verification after each write.
