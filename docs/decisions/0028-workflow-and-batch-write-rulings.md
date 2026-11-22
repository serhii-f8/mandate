# ADR 0028: Rulings for the change-set workflow and the batch writer

- Status: Accepted
- Date: 2026-11-17

## Context

[ADR 0027](0027-execution-on-temporal.md) fixed the shape of execution on Temporal in Phase 5: the change-set
workflow and executor, and the idempotent batch writes. Building them settled a number of
detailed questions that ADR 0027 left open. This record lists those rulings. The rulings for
MCP Tasks and the api path are in [ADR 0029](0029-mcp-tasks-rulings.md).

The numbering follows the original record: items 2 and 3 are the technical rulings; item 1 did
not concern the system and is omitted.

## Decision

2. **Rulings for the workflow:**
   - Activity tuning (timeouts, attempts) travels in the `inspect` result, so the workflow
     builds its activity proxies from recorded values and tests can shrink them.
   - `executeBatch` computes `thresholdExceeded`: the workflow bundle cannot import `core`
     (it pulls in `node:crypto`).
   - `beginExecution` always runs (it supplies batch and run sizes); `verified` skips only
     the guard on resumed runs.
   - Outcome `executor_error` when `beginExecution` exhausts its retries; a failed `prepare`
     sleeps one minute and inspects again.
   - A retried preparation that finds items from an earlier attempt fails
     `preparation_interrupted` instead of producing a silently short change-set.
   - The versioned-key parser moves to `core`; `configurationLoadOptions` and
     `assertFullyChecked` move to `@mandate/upstream`; `PrepareDeps.repository` narrows to a
     `PreparationRepository` subset.
   - A Temporal start failure marks the change-set `failed/executor_unavailable` and throws
     `ExecutorUnavailable`; `progress` queries the workflow only while `executing`.
   - Batches are selected by a `last_target` keyset in target order.
   - The Phase 1 smoke step starts `smokeWorkflow` through a worker CLI that uses the codec
     (the Temporal CLI cannot encrypt, and the codec refuses plaintext).
3. **Rulings for the batch writer:**
   - `ManifestBatchWriter` takes `readerFor(changeset)` and `bulkFor(changeset)` factories,
     so upstream log lines carry the change-set's correlation ID.
   - `Clock` has `now()` and `sleep(ms)`; polling sleeps before each status call.
   - A submit failure that is neither `rejected` nor retriable throws a retryable error;
     exhausted retries end `failed/writer_error`.
   - A non-retriable status failure fails every submitted item `no_outcome`, without
     resubmission.
   - A target missing from the verify read is `skipped/gone`; an unknown per-item state is
     `failed`; a batch ID must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$` (SEC-5).
   - The loader refuses `body`, argument templates and non-write risks on bulk bindings.
   - A status 4xx keeps `http_status`; only the submit maps 4xx to `rejected`.
   - Write recordings change only GLOBEX `meta_keyword` (and one failing `url_key`), keeping
     the ACME data of the Phase 3/4 acceptance intact; `up.sh` restarts the consumer when
     `MANDATE_RESTART_CONSUMER=1`.

## Consequences

- The outcome codes `executor_error` and `preparation_interrupted` join the list in
  [ADR 0027](0027-execution-on-temporal.md).
