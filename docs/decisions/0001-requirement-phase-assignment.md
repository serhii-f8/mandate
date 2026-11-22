# ADR 0001: Requirement-to-phase assignment and the meaning of "CI is green"

- Status: Accepted
- Date: 2026-11-16

## Context

[SPEC](../SPEC.md) sections 5 and 6 define 115 requirement IDs. Section 7, as first written, named
a phase for 102 of them. Every ID must be assigned to exactly one phase. While assigning them, four
further gaps appeared: two open items of section 8 had no Phase 0 spike, MCP-8 was assigned to a
phase that builds only part of it, several requirements cannot be completed in a single phase, and
the Phase 1 criterion "CI is green" could not be met on a hosted service before the repository was
pushed.

## Options considered

1. **Leave the 13 IDs unassigned** and let each phase pick them up. Rejected: an ID nobody owns is
   an ID nobody tests.
2. **Assign cross-cutting IDs to the last phase that touches them**, so `done` is literally true.
   Rejected: it postpones security mechanisms (redaction, server-side enforcement) to the phase
   where they are hardest to retrofit.
3. **Assign each ID to the phase that introduces its mechanism, and list the later phases that must
   extend it.** Chosen.

For "CI is green": (a) treat it as a manual blocker every time, (b) verify locally by running the
script the CI workflow calls. Chosen (b); a hosted run is a follow-up that does not block.

## Decision

1. The thirteen unassigned IDs are assigned as follows.

   | ID | Phase | Reason |
   | --- | --- | --- |
   | MCP-1 | 1 | Phase 1 delivers the MCP endpoint |
   | NFR-3 | 1 | Statelessness is a property of the endpoint from its first version |
   | NFR-5 | 1 | Phase 1 delivers migrations |
   | SEC-1 | 2 | Server-side authorization first exists with the policy engine |
   | NFR-6 | 2 | Policy evaluation and tool-list construction are built here |
   | NFR-14 | 2 | First domain logic in `packages/core` |
   | SEC-3 | 3 | First credentials; Phase 3 acceptance tests their absence from logs |
   | SEC-5 | 3 | First upstream content returned to clients |
   | SEC-7 | 3 | Depends on the connection test (CONN-7) |
   | NFR-7 | 4 | Preparation is the first step that handles large item sets |
   | NFR-2 | 5 | Same work as idempotent writes (EXE-4) |
   | NFR-4 | 5 | First real worker load |
   | NFR-8 | 6 | First item table on a page |

2. **Ownership rule.** Every ID has one owning phase: the one that introduces its mechanism. Where
   the surfaces it applies to arrive later, the later phases are listed with the requirement, and
   the requirement is `partial` until the last of them is done.
3. **Phase 0 has a fifth spike, Magento 2 REST**, resolving the two Magento open items.
4. **MCP-8 is delivered in three phases:** `list_my_operations`, `get_changeset`,
   `cancel_changeset` in Phase 4; `submit_for_approval` in Phase 6; `rollback_changeset` in
   Phase 8.
5. **The `destructive` risk class** is handled in Phase 6 with approvals and step-up.
6. **"CI is green"** means the script invoked by the CI workflow
   ([scripts/ci.sh](../../scripts/ci.sh)) passes when run locally. A hosted run is confirmed after
   the first push.

## Consequences

- SPEC section 7 names all 115 IDs and the fifth spike.
- A phase can be `done` while a requirement it owns is `partial`; Phase 10 has the explicit
  deliverable that every requirement is `done`.
- Later phases must deliver the extensions listed for them, not only the IDs they own.
- A defect that only a hosted CI run would reveal can pass Phase 1 unnoticed.

## Verified

A script compared the IDs in SPEC sections 5–6 with the assignment: 115 in both, no duplicates,
102 assigned by the original section 7 and 13 here.
