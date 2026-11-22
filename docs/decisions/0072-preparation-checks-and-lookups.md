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

This record has two halves: the checks (CS-3, this change) and the lookups that feed them (OPS-7, a
later change of the same release).

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

To be written with OPS-7 (manifest `lookups`, at most 5; a read operation on any connection; key
`{ target: true }`, `{ after: f }`, `{ before: f }` or `{ record: f }`; one read per chunk and lookup;
`lookup_failed` on a failed or truncated read; authorization covered by the write's policy decision).
Until then the loader refuses every lookup reference, `found` and `not_found` as
`is not a declared lookup`, while core already evaluates them over the per-target results that
preparation will supply.

## Consequences

- An approver sees why a record was left out in the operator's words, and a requester learns one code
  per target, nothing of the values behind it.
- A configuration change between preparation and approval can change a title but never a stored
  code; a code that no longer exists in the configuration still shows as itself.
- A precondition that the closed set cannot express needs a code operation (OPS-5) or a later
  extension of the set, which is an additive configuration schema change.

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
