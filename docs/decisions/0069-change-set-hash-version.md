# ADR 0069: Change-sets record the version of their hash format

- Status: Accepted
- Date: 2026-11-22

## Context

The change-set hash (CS-4) binds what an approver saw to what is executed. It is computed once at
preparation and recomputed from the stored items by every check that compares it: the execution
guard (POL-6), the start of a rollback (EXE-8) and the derivation of a new change-set (CS-5). The
recomputation used the one format the code knew, `mandate.changeset.v1`: a header with operation and
normalized arguments, then one line per item.

Release 1.2.0 adds manifest actions (`create` and `delete` beside `update`). Two change-sets with the
same operation, arguments and items but different actions must not share a hash, so the action has to
enter the header. Changing the one format in place would make every change-set prepared before the
upgrade fail its own verification after it, including ones already approved and waiting to execute.
That is the anti-goal of the change-set design: no change-set prepared before an upgrade may stop
verifying because of it.

During a rolling upgrade an old and a new `api` or `worker` run side by side against one database, and
either may prepare, verify or derive any change-set.

## Options considered

1. Change the format in place and ask operators to drain every open change-set before upgrading.
2. Recompute with every known format and accept a match with any of them.
3. Store the format version and the action with each change-set and recompute with the stored ones.

## Decision

Option 3. `change_set.hash_version integer NOT NULL DEFAULT 1` (check `>= 1`) and `change_set.action
text` (NULL or `update`, `create`, `delete`).

- Version 1 is the existing format, byte for byte. Version 2 has the header
  `canonicalJson({ format: 'mandate.changeset.v2', operation, action, args })`, with `action` `null` for
  an opaque change-set, which has no manifest. Item lines are unchanged.
- Both columns are written by `completePreparation`, in the same update as the hash, and not at
  creation. Whichever process computed the hash therefore also records its version: an old process
  never writes the columns and leaves 1 and NULL, which is the version its hash has.
- The update guard `change_set_guard_update` (migration `0015_change_set_hash_version`) fixes both
  once the change-set has left `preparing`, in the same rule as `hash` and `prepared_at`.
- `ChangeSetRecord.hashVersion` is optional in the core model (absent means 1); the repository always
  returns it. `hashStoredItems` recomputes with the stored version and action. A version outside 1 and
  2 throws `UnknownHashVersionError` before any item is read; every caller that compares the result
  with the stored hash answers `hash_mismatch` for it. A derivation refuses such a source with
  `hash_mismatch` before it creates a row.
- New preparations seal with `CURRENT_HASH_VERSION` (2) and the manifest's action (`update` when the
  manifest names none); an opaque preparation seals version 2 without an action. A derived change-set
  keeps its source's version and action, so deriving from a version 1 change-set yields version 1.

Option 2 was rejected because accepting any format that matches weakens the binding: a hash would no
longer say which header it covers. Option 1 puts a drain on every operator for a change the platform
can carry itself.

## Consequences

- Change-sets prepared before 1.2.0 keep verifying, executing, deriving and rolling back as before.
- An old process meeting a version 2 change-set recomputes version 1 and refuses it as
  `hash_mismatch`. That fails closed, but it also blocks the change-set until every process is
  upgraded, so the upgrade note says to upgrade every `api` and `worker` before preparing new
  change-sets.
- A future format adds a version number and a header branch; the column needs no change. A row
  written by a newer release reads back with its version unchecked and fails verification closed on
  an older one.
- The migration adds two columns with constant defaults and two checks, and replaces the guard
  function. It is safe with running workflows and with several instances: existing rows read 1 and
  NULL, which is what their hashes are.

## Verified

2026-11-22: unit tests pin the version 1 vector (unchanged without a seal and with version 1) and a
version 2 vector, and show that the action changes a version 2 digest. `hashStoredItems` verifies a
version 1 and a version 2 change-set against their own hashes and rejects version 3 with
`UnknownHashVersionError`; the execution guard and `beginRollback` answer `hash_mismatch` for it.
Preparation, opaque preparation and derivation tests check the stored seal. The repository contract
runs against the in-memory and the PostgreSQL repository; the PostgreSQL integration tests show the
trigger refusing a change of either column after `preparing`, the checks refusing version 0 and an
unknown action, and a row inserted without the columns (as a 1.1 process does) reading version 1. A
second `drizzle-kit generate` after the migration reports no schema changes.
