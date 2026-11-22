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
  Preparation excludes a record that already exists as `already_exists`. **(call, controller ruling)**
  An `already_exists` item stores the existing record's values as `before` only when that record is
  inside the call's scope; otherwise it stores `before: null`, so a record the requester could not read
  never reaches the item, the approval view or the audit.
- **delete** needs `ids_arg` or `selector`, takes no `values_arg` or `records_arg`, and needs risk
  `destructive` (`action delete needs risk destructive`), so it always needs approval and step-up
  authentication. The item holds the current values of all `fields` as `before` and `after: null`.
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
  an enabled `create` of the same connection whose `fields` cover the delete's. The loader's rule that
  an inverse is a `write` operation accepts `destructive` for the inverse of a create. **(call)**
  Rolling back a delete restores only the manifest's `fields`, not other attributes of the record.
  The inverse of an `update` must itself be an update (`must name an update operation`), so a create or
  delete operation never receives update-shaped records of existing targets.
- **Guard.** The stored action must equal the action of the operation under the current configuration,
  else `policy_denied`, as for diff versus opaque. A change-set stored without an action counts as
  `update`, so a copy derived by an older process from a create or a delete never executes against
  an operation that now creates or deletes.
- Versions: configuration schema 1.2.0, additive (`action` is optional with a default).

## Consequences

- A configuration that changes an operation's action while change-sets of the old action wait for
  execution makes those change-sets unexecutable (`policy_denied`); they are cancelled or expire.
- Deleting is as safe as the operator makes the `fields`: they are what an approver sees and what
  drift compares, and all that a rollback restores.
- The Magento and Gitea presets do not change; the template preset demonstrates both actions in a
  later change of this release.

## Verified

2026-11-22: loader tests load a create, a delete and both inverse pairs, and refuse each case above at
its path with its message; a load test refuses `action` as a preset parameter. Guard tests show a
stored `create` refused under an `update` operation, a stored action-less change-set refused under a
`create` and a `delete` operation and accepted under an `update`, and matching actions accepted.
Writer tests send a create through the per-record `POST` binding and roll it back through the
delete operation's binding against the fake catalog, including the verification after each write.
