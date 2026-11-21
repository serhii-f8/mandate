// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { ChangeSetRecord } from './model.js';
import { OPAQUE_TARGET_ID } from './opaque.js';
import type { BatchContext, BatchSubmission, ChangeWriter, ItemOutcome, OpaqueCaller, OpaqueCallOutcome } from './ports.js';
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

/** The `upstreamBatchId` prefix of a submission that sent no idempotency key. */
const PLAIN_PREFIX = 'opaque:';
/** The `upstreamBatchId` prefix of a submission that sent a key: `opaque-key:<lower-case header>:<batch key>`. */
const KEYED_PREFIX = 'opaque-key:';

/** The submission ID recording whether a key was sent and under which header (EXE-4). */
function submissionId(batchKey: string, header: string | undefined): string {
  return header === undefined ? `${PLAIN_PREFIX}${batchKey}` : `${KEYED_PREFIX}${header}:${batchKey}`;
}

/**
 * The header a recorded submission sent its key under, or undefined when it sent none or the record
 * is not one of ours. An HTTP header name is a token and holds no `:` (RFC 9110 §5.1).
 */
function recordedHeader(submission: BatchSubmission): string | undefined {
  const id = submission.upstreamBatchId;
  if (!id.startsWith(KEYED_PREFIX)) return undefined;
  const end = id.indexOf(':', KEYED_PREFIX.length);
  return end > KEYED_PREFIX.length ? id.slice(KEYED_PREFIX.length, end) : undefined;
}

/**
 * Writes the one item of an opaque change-set as one upstream call, sent at most once (design §5,
 * EXE-4, NFR-2). The submission is recorded in `beforeSend`, after the caller's pre-flight and
 * immediately before the request leaves, and says whether a key was sent and under which header; a
 * fenced attempt throws `BatchFenced` there and nothing is sent. A recorded submission means an
 * earlier attempt may have sent the call: it is resent, with the same key and not recorded again,
 * only when that submission carried a key and the current caller sends it under the same header;
 * otherwise it ends `failed/no_outcome` and nothing is called. On that resend only `accepted` changes
 * the fail-safe outcome: any other answer, including `not_sent` and `refused`, is `failed/no_outcome`,
 * since the first send may have been applied (EXE-5: an unknown outcome is never retried).
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
    const caller = this.deps.callerFor(changeset);
    const header = caller.idempotencyHeader;
    const idempotencyKey = `${changeset.id}:${OPAQUE_TARGET_ID}`;

    if (batch.submission !== undefined) {
      const sent = recordedHeader(batch.submission);
      if (sent === undefined || sent !== header) return [failed(targetId, 'no_outcome')];
      const answer = await caller.call({ args: changeset.args, idempotencyKey, beforeSend: () => Promise.resolve() });
      return [answer.kind === 'accepted' ? { targetId, status: 'written' } : failed(targetId, 'no_outcome')];
    }

    const answer = await caller.call({ args: changeset.args, idempotencyKey, beforeSend: () => record(batch, header) });
    return [outcomeOf(targetId, answer)];
  }
}

/** Throws `BatchFenced` when a newer attempt holds the batch (EXE-4); the caller then sends nothing. */
function record(batch: BatchContext, header: string | undefined): Promise<void> {
  return batch.recordSubmission({
    upstreamBatchId: submissionId(batch.key, header),
    plan: [{ targetId: OPAQUE_TARGET_ID, action: 'write' }],
  });
}
