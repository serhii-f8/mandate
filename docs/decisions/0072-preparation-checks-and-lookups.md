# ADR 0072: Preparation checks and lookups

- Status: Accepted
- Date: 2026-11-22

## Context

Preparation excludes a target for a fixed set of reasons: it is not found, out of scope, lacks
required data, would not change, or (for a create) already exists. A catalog workflow also refuses
records that fail a business precondition: a product that is locked for editing, a status that does
not allow the change, a price below the cost another system holds. Today such a precondition lives in
a script outside the platform, or the approver has to spot it in the item list.

The trust path admits no model and no evaluated configuration code (SEC-5): permission checks, diffs,
approval views and execution are deterministic server code. A precondition language therefore has to
be data the server interprets, small enough to review, and unable to leak what it reads.

This record has two halves: the checks (CS-3) and the lookups that feed them (OPS-7). A precondition
often lives in another system: a part must exist in the ERP before the shop lists it, a cost the ERP
holds bounds a price. The checks alone see only the write's own connection.

## Options considered

1. An expression language (JSONata, CEL, JSON Logic) evaluated per item.
2. Checks in a preset's code module only (OPS-5).
3. A closed set of predicates over named references, declared in the manifest.

## Decision

Option 3. Option 1 brings a parser, an evaluator and their failure modes into the trust path and
makes a configuration hard to review; option 2 leaves configuration-only installations without
preconditions and moves a policy decision into code an operator cannot read in the YAML.

- **Manifest.** `checks: [{ code, title?, require: [<predicate>, ...] }]`, at most 20 checks with 1 to
  10 predicates each. They are evaluated in order on every item that passed the built-in exclusions;
  the first check with a predicate that does not hold excludes the item with reason `code`. An
  excluded item keeps its `before` and `after`, as `no_change` does.
- **Codes.** `code` matches `^[a-z][a-z0-9_]{0,62}$`, is unique within the manifest, is not a
  built-in reason and is not a reserved name (`must not be a reserved name`): a member of
  `Object.prototype`, of which only `constructor` fits the pattern. Independently of the loader, every
  place that counts reasons counts into a map (core `countExclusions`) and every reader uses own keys,
  so even a code written to storage directly, such as `valueOf`, stays a number. `ExclusionReason` becomes the built-in reasons or any such code; every place that
  shows or counts reasons shows an unknown code as it is, after the built-ins, ordered by code.
  **(call)** `checks[*].code` is a fixed node in presets (`must not be a parameter`), like `action` and
  `values_arg`: it is the reason approvers see and stats count, so one preset operation means one set
  of codes on every connection. The literals a check compares against stay bindable.
- **Titles.** `title` is 1 to 120 characters of plain text, shown beside the code (`Note is locked
  (locked)`). The stored item carries only the code; the detail answer adds `reasonTitles` from the
  operation's current configuration as a display label. An untitled or unknown code shows the code.
- **Predicates.** A closed set, no expressions **(call: no `any`/`not`, no regular expressions in
  1.2)**: `{ present: <ref> }`, `{ absent: <ref> }`, `{ equals: [<ref>, <ref> | { value: <literal> }] }`,
  `{ in: <ref>, values: [<literal>...] }` (1 to 100 non-null literals), `{ found: <lookup> }`,
  `{ not_found: <lookup> }`. Each predicate is a strict object with exactly one predicate key.
- **References.** `{ after: f }` and `{ before: f }` name one of `fields` (`null` sides: a create's
  `before`, a delete's `after`); `{ record: f }` the current upstream record, whose fields are added to
  the `read_before` read and must be ones it can return (a create has no record); `{ arg: name }` a
  property of `input_schema`; `{ lookup: name, field: f }` a field of a lookup result.
- **Semantics.** "Present" is not `null`, not missing and not `''`. Equality is canonical JSON with
  `null` and missing equal. `in` compares strictly, without coercion. A value that cannot be compared
  (a non-finite number, a value canonical JSON refuses) makes the predicate false, so the item is
  excluded; evaluation never throws. A predicate or reference of a shape outside the closed set, which
  the loader cannot produce, also fails closed: its predicate is false.
- **When.** Checks run at preparation only. Their outcome is in the hash through each item's status and
  reason. Execution re-checks the written fields (CS-7) but not the check inputs; re-checking them is
  plan 3's verify stage.
- **Secrecy (SEC-3).** Check inputs, a record field outside `fields` or a lookup value, are read and
  dropped: they never reach a stored item, a log, the audit, a tool result, a page or workflow history.
  What leaves is the exclusion code.
- Versions: configuration schema 1.2.0, additive (`checks` is optional).

## Lookups

Options considered for reading another system: (a) a lookup only on the write's own connection, like
`read_before`; (b) a lookup on any connection, through that connection's own read path; (c) a code
operation (OPS-5) that reads both systems. Option (a) misses the case that motivates lookups; option
(c) hides a precondition in code an operator cannot read in the YAML. Decision: option (b).

- **Manifest.** `lookups: { <name>: { operation, ids_arg, key_field, key, fields, args } }`, at most 5,
  each name matching `^[a-z][a-z0-9_]{0,62}$` and not a reserved name. `operation` is an enabled `read`
  operation with `fields_arg` on **any** connection; `ids_arg` names an array property of it (string
  items, or items without a type) whose `maxItems`, if any, is at least `batch_size`; `key_field` and
  the 1 to 50 `fields` are fields it can return (when its field list declares an enum); `args` are
  templates as in `read_before`, each key an argument of the lookup operation and each `{ arg }` a
  property of the write's `input_schema`. Every lookup must be used by a check
  (`is not used by any check`), and a reference `{ lookup: name, field: f }` must name one of that
  lookup's `fields`.
- **Key.** `{ target: true }` (the target ID), `{ after: f }` or `{ before: f }` (a field of `fields`,
  read from the item's side) or `{ record: f }` (a field of the current record, added to the
  `read_before` read like the `{ record }` references of the checks, and refused when that read cannot
  return it). A key value that is not a string or a number, a missing field or a `null` side gives
  the item no key, and the lookup is "not found" for it.
- **Reads.** Per read chunk and per lookup, after the `read_before` read: one read of the distinct
  keys of the items that are still pending after the built-in exclusions, in chunks of `batch_size`,
  asking for `key_field` and `fields`. Results are indexed by `key_field` as a string, the first
  record with a key winning. Items that are already excluded run no check and cause no lookup read.
- **Failures.** A failed lookup read fails the preparation with the fixed code `lookup_failed` and
  the upstream HTTP status when there was one, never the upstream message. A truncated read fails it
  with `incomplete_read`, as a truncated `read_before` read does. A lookup that could not be read
  completely is never read as "not found".
- **Authorization (call).** The operator declared the lookup in the write's manifest, and the write
  operation's policy decision covers it, as it already covers `read_before` and `selector`. The
  requester needs no grant on the lookup operation. A requester can therefore cause reads on a
  connection they hold no grant for, but only the reads the operator wrote into the manifest, keyed
  by the targets of a call the policy allowed. What the requester can learn is one exclusion code per
  target: whether a key was found, or whether a field compared as the check says. An operator who
  does not want that leak must not declare the lookup.
- **Secrecy (SEC-3).** Lookup values are used by checks only: they are read during preparation,
  dropped after the chunk's checks, and never stored, shown, audited, logged or returned. They are not
  in workflow history: the prepare activity takes the change-set identifier only.
- **Connection.** A lookup read goes through the lookup operation's own connection: its egress rules,
  its pacing and its credential, never the write connection's and never the user's access token
  (AUTH-7). It is a read bound to `GET` (CS-1); the reader refuses any other operation.
- **Presets.** A lookup's `operation` may be a `{ $param }`: a preset cannot know the operations of
  another connection, so the binding names one. Lookup names are not fixed nodes: they are mapping
  keys, which a `{ $param }` cannot replace, and are never shown or counted; a reference to them is
  checked after substitution. A lookup on one of the preset's own reads follows `operation_prefix`
  like `read_before`.
- Versions: configuration schema 1.2.0, additive (`lookups` is optional).

## Consequences

- An approver sees why a record was left out in the operator's words, and a requester learns one code
  per target, nothing of the values behind it.
- A configuration change between preparation and approval can change a title but never a stored
  code; a code that no longer exists in the configuration still shows as itself.
- A precondition that the closed set cannot express needs a code operation (OPS-5) or a later
  extension of the set, which is an additive configuration schema change.
- A lookup adds one read per chunk and lookup to a preparation; an unavailable lookup connection
  fails the preparation (`lookup_failed`) instead of letting records through unchecked.
- An operator who declares a lookup on a connection lets every requester of the write learn, per
  target, the outcome of the checks that read it, without a grant on that connection.

## Verified

2026-11-22: core unit tests cover each predicate, `''` as not present, `null` equal to missing,
`in` without coercion, an incomparable value (`NaN`) failing instead of throwing, the first failing
check naming the reason, the lookup predicates over supplied results, update, create and delete items
(built-in reasons first, `no_change` kept), the `{ record }` fields added to the read, and stats
counting a custom code. Loader tests refuse each schema bound and each cross-check at its path with
its message; a load test refuses a check code as a preset parameter. Component tests show
`excluded: Note is locked (locked)`, `excluded: locked` without a title, and custom codes after the
built-ins in the stats summary and the prepared result text. Fix round 1: a repository contract test
(PostgreSQL and in-memory) stores items excluded with `locked`, `valueOf` and `constructor` and reads
numeric counts; a core test shows the `prepared` audit event counting a `constructor` code as a number;
a loader test refuses `constructor`; core tests show an unknown predicate or reference shape failing.

2026-11-22 (lookups): core unit tests cover each key form, a key that is an object, missing or on a
`null` side, three reads for 250 keys in chunks of 100, duplicate keys sent once, the template values
and the field list in the read, `lookup_failed` with status 503 and `incomplete_read` on a truncated
read; a preparation test excludes the target the lookup does not return with the check's code, finds
no value of the lookup in the stored items, the audit or the returned change-set, reads only for
pending items and adds a `{ record }` key to the `read_before` fields. Loader tests cover a lookup on
another connection and each refusal at its path. A worker integration test runs the prepare activity
with the production `UpstreamReader` against two fake upstreams: the target the second connection
does not know is excluded, and the second upstream saw only `GET` requests, each with its own
connection's bearer credential and none with the first's. The reader needed no change.
