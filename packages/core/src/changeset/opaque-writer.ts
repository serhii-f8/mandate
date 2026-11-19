import type { ChangeSetRecord } from './model.js';
import { OPAQUE_TARGET_ID } from './opaque.js';
import type { BatchContext, ChangeWriter, ItemOutcome, OpaqueCaller, OpaqueCallOutcome } from './ports.js';
import type { WriteOutcomeCode } from './writer.js';

export interface OpaqueCallWriterDeps {
  readonly callerFor: (changeset: ChangeSetRecord) => OpaqueCaller;
}

type WriteInput = Parameters<ChangeWriter['writeBatch']>[0];

function failed(targetId: string, error: WriteOutcomeCode): ItemOutcome {
  return { targetId, status: 'failed', error };
}

function outcomeOf(targetId: string, answer: OpaqueCallOutcome): ItemOutcome {
  switch (answer.kind) {
    case 'accepted':
      return { targetId, status: 'written' };
    case 'refused':
      return failed(targetId, 'upstream_rejected');
    case 'unknown':
      return failed(targetId, 'no_outcome');
    case 'not_sent':
      return failed(targetId, answer.code);
  }
}

/**
 * Writes the one item of an opaque change-set as one upstream call, sent at most once (design §5,
 * EXE-4, NFR-2). A recorded submission means an earlier attempt may have sent it: without
 * idempotency it ends `failed/no_outcome` and nothing is called; with idempotency it is resent with
 * the same key and not recorded again. Otherwise the submission is recorded in `beforeSend`, after
 * the caller's pre-flight and immediately before the request leaves; a fenced attempt throws
 * `BatchFenced` there and nothing is sent (EXE-5: an unknown outcome is never retried).
 */
export class OpaqueCallWriter implements ChangeWriter {
  constructor(private readonly deps: OpaqueCallWriterDeps) {}

  async writeBatch(input: WriteInput): Promise<readonly ItemOutcome[]> {
    const { changeset, items, batch } = input;
    const [item, ...rest] = items;
    if (item === undefined) return [];
    // Exactly one item named `call`; anything else is not an opaque change-set and is never sent.
    if (rest.length > 0 || item.targetId !== OPAQUE_TARGET_ID) {
      return items.map((i) => failed(i.targetId, 'write_mode_unsupported'));
    }
    const targetId = item.targetId;
    const resumed = batch.submission !== undefined;
    const caller = this.deps.callerFor(changeset);
    if (resumed && !caller.idempotent) return [failed(targetId, 'no_outcome')];

    const answer = await caller.call({
      args: changeset.args,
      idempotencyKey: `${changeset.id}:${OPAQUE_TARGET_ID}`,
      beforeSend: resumed ? () => Promise.resolve() : () => record(batch),
    });
    return [outcomeOf(targetId, answer)];
  }
}

/** Throws `BatchFenced` when a newer attempt holds the batch (EXE-4); the caller then sends nothing. */
function record(batch: BatchContext): Promise<void> {
  return batch.recordSubmission({
    upstreamBatchId: `opaque:${batch.key}`,
    plan: [{ targetId: OPAQUE_TARGET_ID, action: 'write' }],
  });
}
