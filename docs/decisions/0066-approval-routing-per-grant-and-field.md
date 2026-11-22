# ADR 0066: Approval routing per grant and per touched field

- Status: Accepted
- Date: 2026-11-22

## Context

POL-5 decides approval from the operation's risk class, the record count and one rule per role, the
rule of the role that allowed the call (ADR 0027, ADR 0030). A shop wants content changes approved by
a content lead and price changes by a pricing owner, and the same editor makes both in one call: the
role's single rule cannot tell them apart. Splitting the editor into two roles forces the caller to
pick a role per call, which the policy engine does not offer (the caller holds all mapped roles).

## Options considered

1. Two roles, one per kind of change. A call touching both kinds is allowed by whichever grant
   matches first, so the stricter rule can be skipped.
2. A rule per grant only. A grant covers one operation, and `price` and `name` travel in the same
   operation.
3. A rule per grant, and an ordered list of field rules on the role's or the grant's rule. The first
   field rule with a field the call touches replaces the rule.

## Decision

Option 3.

- `grants[].approval` has the shape of `roles[].approval`. It replaces the role's rule for the calls
  that grant allows.
- `approval.field_rules` (on a role or a grant) is an ordered list of
  `{ fields, required?, record_threshold?, steps?, step_up_max_age_seconds?, allow_widget? }`. A field
  rule does not nest. `fields` is not empty.
- Resolution (`resolveApprovalRule` in core): the grant's rule, else the role's; then the first field
  rule of the chosen rule that names a touched field; else the chosen rule. `approvalRequirement` runs
  unchanged on the result.
- "Touched" is what POL-3 reads from the operation's `fields_arg` (`touchedCallFields`). When the
  fields cannot be read, or the operation cannot be found, and the chosen rule has field rules, the change
  cannot be routed: the resolved rule requires approval and has no steps, which `approvalRequirement`
  reports as unroutable, so submission is refused (`approval_unroutable`), the guard denies and
  `config explain` prints unroutable. Picking the first field rule would be wrong: it can be weaker than
  the base rule. A chosen rule without field rules is returned unchanged.
- The decision rule of an allow (`role:<role>/grant:<id|index>`) names the grant; `grantReference` in
  core builds it for the policy engine and the loader alike. The loaded
  configuration carries `grantApproval`, keyed by that reference, and `approvalRuleFor` in
  `@mandate/config` looks both maps up. A trailing suffix such as `/scope:brand` is ignored.
- The same helper runs at submission (`api`), at the execution guard (`worker`, POL-6) and in
  `config explain`, so an approval collected under one configuration does not satisfy another that
  routes the touched field elsewhere. The guard is an activity, not workflow code, so no `patched`
  marker is needed.
- Loader checks: every step role exists; the threshold rules of role approval hold for every rule;
  `field_rules` on a grant needs `fields_arg` on its operation, on a role it needs it on every write
  grant the role's rule covers; a field name must be a field of every such operation whose fields
  argument is closed (an object with `additionalProperties: false`: its `properties`; an array with
  `items.enum`: that enum), since a rule naming another field never matches, and an open schema
  is not checked; every rule that can require approval of a write has at least one step
  (a field rule included). The roles that appear in grant and field rules count as approver roles for
  the review and decide tools, and a grant's rule is part of its role in `config diff`.

## Consequences

- Public interface: the configuration schema gains optional keys (config 1.1.0, additive); the loaded
  configuration gains `grantApproval`.
- Rule order matters among field rules; the first match wins, not the strictest. A configuration that
  wants the strictest must list it first.
- A role approval that sets `required: never` with a field rule `required: always` approves only the
  touched-field changes; an unreadable `fields_arg` argument makes the change unroutable.
- A change-set approved before a configuration change must have the approvals the new configuration
  asks for, or the guard refuses it as `approval_missing`.

## Verified

Unit tests of the resolution in core, of the loader checks (field names against closed object and
enum schemas, an open schema, grant-level and role-level rules), and of the three call sites
(submission plan, guard under configuration A and B, `config explain`), with submission and guard
tests where a grant's own rule, keyed by index and by grant ID, decides the steps through a loaded
configuration and the real policy engine.
