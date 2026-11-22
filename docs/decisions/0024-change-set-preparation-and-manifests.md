# ADR 0024: Change-set preparation, manifests and the executor interface

- Status: Accepted
- Date: 2026-11-17

## Context

Phase 4 turns allowed `write` calls into prepared, hashed change-sets (OPS-2–OPS-4, CS-1–CS-4,
CS-6, NFR-7), adds the built-in tools `list_my_operations`, `get_changeset` and
`cancel_changeset` (MCP-8) and defines the executor interface with an in-memory
implementation (EXE-11). Temporal operation workflows are Phase 5, so SPEC section 2 steps
3–4 (preparation in a worker activity) cannot be built as written yet.

## Options considered

1. **Subsystem split:** one; two (preparation and storage; executor). The executor
   interface is small and its in-memory implementation consumes the repository the
   preparation writes, so they share one contract surface.
2. **Where preparation runs:** in `api` synchronously; in a Temporal activity; in `api`
   asynchronously after returning.
3. **After values:** one uniform field → value object; per-target values; expressions.
4. **Fields an item stores:** the manifest fields the call changes; all manifest fields.
5. **Manifest reads and policy:** require a grant on the read operations; no separate
   decision, scope forced into the reads by configuration checks and re-checked per record.
6. **Hash content:** included items only; every item including excluded ones and reasons.
7. **Lifecycle gaps:** a preparation that cannot complete; an execution stopped by EXE-7.
   Options: reuse `cancelled`/`expired`; add `preparing → failed` and `executing → cancelled`.
8. **Expiry:** environment variable; configuration key; per operation. Enforcement: a
   sweeper; lazy compare-and-set on access.
9. **Immutability after `prepared`:** code convention; database triggers plus convention.
10. **Magento batched read:** repeated `sku` query parameters; one `in` filter with a
    comma-joined value (needs a template extension).
11. **Who reads and cancels a change-set in Phase 4:** anyone with the ID; the requester only.

## Decision

1. **One subsystem**: preparation, storage and the executor interface are handled together.
2. **In `api`, synchronously, through a core service on ports** (`ChangeSetRepository`,
   `UpstreamReader`). This is an interim for Phase 4: Phase 5 either calls the same
   service from a worker activity started by the operation workflow (SPEC section 2) or,
   if it finds a reason not to, amends section 2. The synchronous call is bounded by
   `max_targets`; a crash leaves `preparing`, which expiry closes.
3. **Uniform values** (`values_arg`), so POL-3 checks the touched fields with the existing
   `fields_arg` mechanism, which defaults to `values_arg` for manifest operations.
4. **Touched fields only.** CS-2 is reworded accordingly: before values never show a
   field the caller's grant denies, and CS-7 compares only what will be written.
5. **No separate decision for manifest reads.** The write decision covers them; loader
   checks force every grant scope argument into `scope_args` and into the read templates,
   and every record is re-checked against the call's scope arguments (`out_of_scope`
   items store no values). The reader validates arguments with the read operation's own
   validator and refuses anything but a GET read (CS-1 in code).
6. **Every item, with status and reason**, in canonical JSON (RFC 8785 style), items in
   code-point order of `target_id`, format tag `mandate.changeset.v1`, `sha256:<hex>`.
7. **Add `preparing → failed` and `executing → cancelled`** to SPEC section 4. Reusing
   `cancelled` for a failed preparation would hide errors; reusing `failed` for EXE-7
   would report a deliberate stop as an error. The full transition table lives in core now.
8. **Configuration key `changesets.expire_after_hours`** (default 72, one document at most),
   configuration as code (SPEC section 1). **Lazy expiry** in Phase 4 (on `get_changeset`,
   `cancel_changeset`, executor `start`), actor `system`; Phase 6 adds the workflow timer.
9. **Triggers plus convention**: items insertable only while the parent is `preparing`, no
   deletes, content columns and exclusions immutable; change-set identity columns
   immutable, hash and stats settable only while `preparing`. Execution columns stay
   updatable for Phase 5.
   Execution columns (item `status`, `error`) change only while the change-set is
   `executing` or `rolling_back`: item statuses are hashed content.
10. **`join` on template values** (connector SDK 0.1.0 → 0.2.0, additive, NFR-18).
11. **Requester only**; unknown and foreign IDs give the same answer. Phase 6 adds approvers.

Also: the executor's `start` requires the caller's `expectedHash` to equal the stored hash
(SEC-9 groundwork) and is allowed from `prepared` or `approved`; whether approval is needed
in front of it is POL-5 (Phase 6). The in-memory executor ends `completed`,
`completed_with_errors` or `failed` (all items failed or the writer threw); a contract
suite in `packages/testing` is the bar the Temporal implementation must pass in Phase 5.

## Consequences

- The `write` tool call can take as long as preparation; Phase 5 moves long preparations
  behind the Tasks extension (MCP-7).
- A uniform-values operation cannot express per-target values yet.
- Grants on `catalog.update_content` need no grant on the read operations it uses; the
  read operations still appear to a role only if granted.
- SKUs containing commas cannot be targeted through the Magento preset (input pattern).
- SPEC section 4 and CS-2 were changed together with this decision.

## Verified

2026-11-17, against the Mage-OS 4.0.0 sandbox of Phase 3 (`deploy/sandbox/magento`,
`http://127.0.0.1:4390/rest/all/V1/products`, admin token from `token.sh`), with a throwaway
probe script:

- filter group 0 `brand eq acme` plus filter group 1 `sku in ACME-001,ACME-003,GLOBEX-001`,
  `pageSize=100` → `total_count 2`, items `["ACME-001","ACME-003"]` (the comma list works
  and the brand filter excludes the other brand's SKU);
- `brand eq acme`, `sortOrders[0][field]=sku`, `direction=ASC`, `pageSize=2`: page 1
  `["ACME-001","ACME-002"]`, page 2 `["ACME-003"]`, page 5 `[]` with `total_count 3`
  (pages past the end are empty on this build; preparation still stops at the total);
- a product's `custom_attributes` hold `description`, `short_description`, `url_key`,
  `brand` and `cost`; `meta_title` is absent when unset (stored as `null` before values).

No MCP SDK, MCP Apps, Temporal or Keycloak behaviour is decided here: the built-in tools use
the Phase 2 low-level handlers unchanged ([ADR 0016](0016-policy-evaluation-and-mcp-enforcement.md)), and the executor interface is
implementation-neutral.
