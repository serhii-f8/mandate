# ADR 0007: Magento bulk endpoints and idempotency

- Status: Accepted
- Date: 2026-11-16

## Context

The Magento preset updates product content in bulk (`update_content`). Magento 2 REST has no
idempotency key, and its bulk API is asynchronous: a request is queued and a consumer applies it
later. Requirements in play: CONN-2 (OpenAPI import), OPS-6 (use upstream bulk endpoints),
EXE-3/EXE-4/EXE-5 (batches, idempotent writes, per-item outcome), CS-7 (drift detection against the
stored `before`). A Temporal activity may be retried after a timeout while its first submission is
still queued. This was decided in Phase 0, spike 5.

Sandbox: Mage-OS 4.0.0 (Magento 2.4.9 based), PHP 8.3, MariaDB 11.4, OpenSearch 3.0.0, db queue.

## Options considered

1. Read-before-write against the change-set's `before`/`after` (skip if current == after, write if
   current == before, else drift).
2. Marker attribute carrying change-set and item ID, written with the content.
3. Rely on `PUT`/`POST` being a full-value set (blind retry).

Endpoint options for the write: sync `PUT /V1/products/{sku}`; `PUT /async/V1/products/{sku}`;
`POST /async/bulk/V1/products`; `PUT /async/bulk/V1/products/bySku` (the documented update route).

## Decision

- Write path: `POST /rest/all/async/bulk/V1/products`, body = array of
  `{"product": {"sku", "status", <fields>}}`. Always send the product's current `status` (read in
  the same batched read) because all `/async` paths reset an omitted `status` to 1. The documented
  `PUT /async/bulk/V1/products/bySku` returned 400 "Request body must be an array" on this build
  and is not used.
- Idempotency: option 1, with one batched read per batch (search with `sku in (...)`,
  `pageSize = batch size`), then one bulk write for the `before`-matching items. Skipped items
  (current == after) cost no write; drift items (neither) are skipped and reported (CS-7).
- Persist the `bulk_uuid` in the change-set item/batch record immediately after submission. A
  retried activity first polls the stored `bulk_uuid`; it re-reads and re-submits only if no
  `bulk_uuid` is recorded or the bulk is closed. Read-before-write alone cannot see a queued
  submission.
- Use scope `all` consistently for reads and writes (`/rest/all/...`), never mix with `/rest/V1`
  (store view).
- Per-item outcome from `GET /V1/bulk/{uuid}/detailed-status`, mapped by operation `id` = payload
  index; confirm with the next batched read (current == after).
- Batch size default 100 items per bulk (configurable in the manifest); no hard limit was reached
  in the spike (verified 20 only; 100 is a guess marked `unverified`, to be measured in Phase 3).
- Import the OpenAPI schema filtered to
  `catalogProductRepositoryV1,asynchronousOperationsBulkStatusV1`; async routes are not in the
  schema and are declared by the preset.

## Consequences

- Cost per batch of N: 1 read + 1 bulk write + about 2-3 status polls (+ optional
  detailed-status); a fully applied retry costs 1 read and 0 writes. Per item about (2 + polls)/N
  calls.
- No catalog schema changes or marker attributes are needed; drift detection comes for free.
- A residual race remains: a write that is queued (or an external edit between read and consumer
  execution) can overwrite a newer external edit (demonstrated). Mitigations: small queue latency,
  stored `bulk_uuid`, post-batch verification read reports mismatches as drift.
- The preset depends on a running consumer (`async.operations.all`) on the target store
  (documented as prerequisite of the preset; connection test should check that a harmless bulk
  completes).
- Failed items are not retried by the platform automatically unless `status` is 2 (retriable);
  status 3 means change the input.
- Rejected: option 2 (needs extra attribute per store, extra bytes in every write, no drift
  detection, still needs the read); option 3 alone (cannot satisfy CS-7; cannot detect queued
  duplicates; clobbers newer edits).

## Verified

Experiments by `spikes/5-magento-rest/run.sh` on 2026-11-16 against Mage-OS 4.0.0 in Docker (27/27
assertions). Documentation read 2026-11-16:
https://developer.adobe.com/commerce/webapi/rest/use-rest/bulk-endpoints/ and
https://developer.adobe.com/commerce/webapi/rest/use-rest/asynchronous-web-endpoints/. Batch size
100 and behaviour on stock Magento Open Source / Adobe Commerce (as opposed to Mage-OS) are
`unverified`.
