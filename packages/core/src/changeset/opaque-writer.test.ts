// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { ChangeItemRecord, ChangeSetRecord } from './model.js';
import { OpaqueCallWriter } from './opaque-writer.js';
import {
  BatchFenced,
  type BatchContext,
  type BatchSubmission,
  type OpaqueCaller,
  type OpaqueCallOutcome,
  type OpaqueNotSentCode,
} from './ports.js';

// ---- Fakes: the caller and the batch write into one ordered `events` log. ----

type CallInput = Parameters<OpaqueCaller['call']>[0];

/** Honours the port contract: pre-flight (`not_sent` answers before `beforeSend`), then `beforeSend`, then one send. */
class ScriptedCaller implements OpaqueCaller {
  readonly calls: { args: Readonly<Record<string, unknown>>; idempotencyKey: string }[] = [];
  readonly files: (CallInput['files'])[] = [];
  readonly idempotencyHeader?: string;
  constructor(
    private readonly events: string[],
    private readonly outcome: OpaqueCallOutcome,
    idempotencyHeader?: string,
  ) {
    if (idempotencyHeader !== undefined) this.idempotencyHeader = idempotencyHeader;
  }
  async call(input: CallInput): Promise<OpaqueCallOutcome> {
    this.calls.push({ args: input.args, idempotencyKey: input.idempotencyKey });
    this.files.push(input.files);
    if (this.outcome.kind === 'not_sent') return this.outcome;
    await input.beforeSend();
    this.events.push('send');
    return this.outcome;
  }
}

class FakeBatch implements BatchContext {
  readonly key = 'cs-1:1';
  submission?: BatchSubmission;
  readonly recorded: BatchSubmission[] = [];
  constructor(
    private readonly events: string[],
    private readonly fenced = false,
  ) {}
  recordSubmission(s: BatchSubmission): Promise<void> {
    this.events.push('record');
    if (this.fenced) return Promise.reject(new BatchFenced());
    this.recorded.push(s);
    this.submission = s;
    return Promise.resolve();
  }
  heartbeat(): void {
    this.events.push('heartbeat');
  }
}

const changeset: ChangeSetRecord = {
  id: 'cs-1',
  operation: 'shop.purge_cache',
  connection: 'shop',
  requester: 'alice',
  args: { scope: 'all' },
  hash: 'h-1',
  status: 'executing',
  stats: { total: 1, included: 1, excluded: {}, written: 0, failed: 0, skipped: 0 },
  configHash: 'cfg-1',
  correlationId: 'corr-1',
  createdAt: new Date('2026-11-17T10:00:00.000Z'),
  expiresAt: new Date('2026-11-20T10:00:00.000Z'),
  approvalRound: 1,
};

const callItem: ChangeItemRecord = { targetId: 'call', status: 'pending', before: null, after: { scope: 'all' } };

const RECORDED: BatchSubmission = { upstreamBatchId: 'opaque:cs-1:1', plan: [{ targetId: 'call', action: 'write' }] };
/** A submission recorded by an attempt that sent the key under `idempotency-key`. */
const RECORDED_KEYED: BatchSubmission = { upstreamBatchId: 'opaque-key:idempotency-key:cs-1:1', plan: [{ targetId: 'call', action: 'write' }] };
const HEADER = 'idempotency-key';

function setup(outcome: OpaqueCallOutcome, opts: { idempotencyHeader?: string; fenced?: boolean } = {}) {
  const events: string[] = [];
  const caller = new ScriptedCaller(events, outcome, opts.idempotencyHeader);
  const batch = new FakeBatch(events, opts.fenced ?? false);
  const seen: ChangeSetRecord[] = [];
  const writer = new OpaqueCallWriter({
    callerFor: (cs) => {
      seen.push(cs);
      return caller;
    },
  });
  return { events, caller, batch, seen, writer };
}

const NOT_SENT_CODES: readonly OpaqueNotSentCode[] = [
  'upstream_rejected',
  'credential_missing',
  'credential_unusable',
  'egress_denied',
  'upstream_changed',
  'upstream_unavailable',
  'file_unavailable',
];

describe('EXE-4 NFR-2 OpaqueCallWriter', () => {
  it('records the submission before sending, then written on accepted', async () => {
    const { events, caller, batch, seen, writer } = setup({ kind: 'accepted' });
    const outcomes = await writer.writeBatch({ changeset, items: [callItem], batch });
    expect(events).toEqual(['record', 'send']);
    expect(batch.recorded).toEqual([RECORDED]);
    expect(outcomes).toEqual([{ targetId: 'call', status: 'written' }]);
    expect(caller.calls).toEqual([{ args: { scope: 'all' }, idempotencyKey: 'cs-1:call' }]);
    expect(seen).toEqual([changeset]);
  });

  it('a recorded submission without idempotency ends failed/no_outcome and calls nothing', async () => {
    const { events, caller, batch, seen, writer } = setup({ kind: 'accepted' });
    batch.submission = RECORDED;
    const outcomes = await writer.writeBatch({ changeset, items: [callItem], batch });
    expect(outcomes).toEqual([{ targetId: 'call', status: 'failed', error: 'no_outcome' }]);
    expect(caller.calls).toEqual([]);
    expect(events).toEqual([]);
    expect(batch.recorded).toEqual([]);
    expect(seen.length).toBeLessThanOrEqual(1);
  });

  it('EXE-4 a fresh keyed call records the header it sends with the submission', async () => {
    const { events, batch, writer } = setup({ kind: 'accepted' }, { idempotencyHeader: HEADER });
    const outcomes = await writer.writeBatch({ changeset, items: [callItem], batch });
    expect(events).toEqual(['record', 'send']);
    expect(batch.recorded).toEqual([RECORDED_KEYED]);
    expect(outcomes).toEqual([{ targetId: 'call', status: 'written' }]);
  });

  it('a recorded keyed submission is resent with the same key under the same header and not recorded again', async () => {
    const { events, caller, batch, writer } = setup({ kind: 'accepted' }, { idempotencyHeader: HEADER });
    batch.submission = RECORDED_KEYED;
    const outcomes = await writer.writeBatch({ changeset, items: [callItem], batch });
    expect(events).toEqual(['send']);
    expect(batch.recorded).toEqual([]);
    expect(caller.calls).toEqual([{ args: { scope: 'all' }, idempotencyKey: 'cs-1:call' }]);
    expect(outcomes).toEqual([{ targetId: 'call', status: 'written' }]);
  });

  it('EXE-4 a resumed call is not resent when the recorded submission carried no key', async () => {
    // Attempt 1 ran without idempotency; a reload since added it. The upstream never saw a key.
    const { events, caller, batch, writer } = setup({ kind: 'accepted' }, { idempotencyHeader: HEADER });
    batch.submission = RECORDED;
    const outcomes = await writer.writeBatch({ changeset, items: [callItem], batch });
    expect(outcomes).toEqual([{ targetId: 'call', status: 'failed', error: 'no_outcome' }]);
    expect(caller.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it('EXE-4 a resumed call is not resent when the current caller sends the key under another header', async () => {
    const { events, caller, batch, writer } = setup({ kind: 'accepted' }, { idempotencyHeader: 'x-request-id' });
    batch.submission = RECORDED_KEYED;
    const outcomes = await writer.writeBatch({ changeset, items: [callItem], batch });
    expect(outcomes).toEqual([{ targetId: 'call', status: 'failed', error: 'no_outcome' }]);
    expect(caller.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it('EXE-4 a resumed keyed call is not resent when the current caller sends no key', async () => {
    const { caller, batch, writer } = setup({ kind: 'accepted' });
    batch.submission = RECORDED_KEYED;
    expect(await writer.writeBatch({ changeset, items: [callItem], batch })).toEqual([{ targetId: 'call', status: 'failed', error: 'no_outcome' }]);
    expect(caller.calls).toEqual([]);
  });

  it('EXE-4 a resumed idempotent call whose resend is not_sent or refused ends failed/no_outcome', async () => {
    const answers: OpaqueCallOutcome[] = [{ kind: 'refused' }, { kind: 'unknown' }, ...NOT_SENT_CODES.map((code) => ({ kind: 'not_sent' as const, code }))];
    for (const answer of answers) {
      const { caller, batch, writer } = setup(answer, { idempotencyHeader: HEADER });
      batch.submission = RECORDED_KEYED;
      const outcomes = await writer.writeBatch({ changeset, items: [callItem], batch });
      expect(outcomes, answer.kind).toEqual([{ targetId: 'call', status: 'failed', error: 'no_outcome' }]);
      expect(caller.calls).toHaveLength(1);
      expect(batch.recorded).toEqual([]);
    }
  });

  it('refused is failed/upstream_rejected; unknown is failed/no_outcome', async () => {
    const refused = setup({ kind: 'refused' });
    expect(await refused.writer.writeBatch({ changeset, items: [callItem], batch: refused.batch })).toEqual([
      { targetId: 'call', status: 'failed', error: 'upstream_rejected' },
    ]);
    expect(refused.events).toEqual(['record', 'send']);

    const unknown = setup({ kind: 'unknown' });
    expect(await unknown.writer.writeBatch({ changeset, items: [callItem], batch: unknown.batch })).toEqual([
      { targetId: 'call', status: 'failed', error: 'no_outcome' },
    ]);
    expect(unknown.events).toEqual(['record', 'send']);
  });

  it('not_sent ends failed with its code and records nothing', async () => {
    for (const code of NOT_SENT_CODES) {
      const { events, batch, writer } = setup({ kind: 'not_sent', code });
      const outcomes = await writer.writeBatch({ changeset, items: [callItem], batch });
      expect(outcomes).toEqual([{ targetId: 'call', status: 'failed', error: code }]);
      expect(events).toEqual([]);
      expect(batch.recorded).toEqual([]);
    }
  });

  it('a fenced record propagates BatchFenced and nothing is sent', async () => {
    const { events, batch, writer } = setup({ kind: 'accepted' }, { fenced: true });
    await expect(writer.writeBatch({ changeset, items: [callItem], batch })).rejects.toBeInstanceOf(BatchFenced);
    expect(events).toEqual(['record']);
  });

  it('the idempotency key is <changeset-id>:call', async () => {
    const { caller, batch, writer } = setup({ kind: 'accepted' }, { idempotencyHeader: HEADER });
    await writer.writeBatch({ changeset: { ...changeset, id: 'cs-42' }, items: [callItem], batch });
    expect(caller.calls.map((c) => c.idempotencyKey)).toEqual(['cs-42:call']);
  });

  it('more than one item fails every item with write_mode_unsupported', async () => {
    const { events, caller, batch, writer } = setup({ kind: 'accepted' });
    const second: ChangeItemRecord = { ...callItem, targetId: 'other' };
    const outcomes = await writer.writeBatch({ changeset, items: [callItem, second], batch });
    expect(outcomes).toEqual([
      { targetId: 'call', status: 'failed', error: 'write_mode_unsupported' },
      { targetId: 'other', status: 'failed', error: 'write_mode_unsupported' },
    ]);
    expect(caller.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it('an item other than call fails with write_mode_unsupported and calls nothing', async () => {
    const { events, caller, batch, writer } = setup({ kind: 'accepted' });
    const outcomes = await writer.writeBatch({ changeset, items: [{ ...callItem, targetId: 'sku-1' }], batch });
    expect(outcomes).toEqual([{ targetId: 'sku-1', status: 'failed', error: 'write_mode_unsupported' }]);
    expect(caller.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it('zero items answer no outcomes and call nothing', async () => {
    const { events, caller, batch, writer } = setup({ kind: 'accepted' });
    expect(await writer.writeBatch({ changeset, items: [], batch })).toEqual([]);
    expect(caller.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it('an error thrown by the caller propagates unchanged', async () => {
    const events: string[] = [];
    const boom = new Error('transport bug');
    const batch = new FakeBatch(events);
    const writer = new OpaqueCallWriter({
      callerFor: () => ({ call: () => Promise.reject(boom) }),
    });
    await expect(writer.writeBatch({ changeset, items: [callItem], batch })).rejects.toBe(boom);
  });
});

describe('EXE-4 CS-10 OpaqueCallWriter with files', () => {
  const links = [{ pointer: '/doc', fileId: '11111111-1111-4111-8111-111111111111' }] as const;
  const withFiles: ChangeSetRecord = { ...changeset, files: links };

  it('CS-10 not_sent/file_unavailable makes the item failed with error file_unavailable', async () => {
    const { batch, writer } = setup({ kind: 'not_sent', code: 'file_unavailable' });
    expect(await writer.writeBatch({ changeset: withFiles, items: [callItem], batch })).toEqual([
      { targetId: 'call', status: 'failed', error: 'file_unavailable' },
    ]);
    expect(batch.recorded).toEqual([]);
  });

  it('CS-10 the change-set links go to the caller on the first send and on the resend of a keyed submission', async () => {
    const first = setup({ kind: 'accepted' }, { idempotencyHeader: HEADER });
    await first.writer.writeBatch({ changeset: withFiles, items: [callItem], batch: first.batch });
    expect(first.caller.files).toEqual([links]);

    const resend = setup({ kind: 'accepted' }, { idempotencyHeader: HEADER });
    resend.batch.submission = RECORDED_KEYED;
    await resend.writer.writeBatch({ changeset: withFiles, items: [callItem], batch: resend.batch });
    expect(resend.caller.files).toEqual([links]);
  });

  it('CS-10 a change-set without files passes none', async () => {
    const { caller, batch, writer } = setup({ kind: 'accepted' });
    await writer.writeBatch({ changeset, items: [callItem], batch });
    expect(caller.files).toEqual([undefined]);
  });
});
