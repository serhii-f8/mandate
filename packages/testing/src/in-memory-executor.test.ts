// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATS,
  type BatchContext,
  type BatchSubmission,
  type ChangeItemRecord,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type ManifestDefinition,
  type ManifestVerifyAfter,
  type ReadPage,
  type UpstreamReader,
  BatchFenced,
} from '@mandate/core';
import { describeExecutorContract, describeRollbackRun, EXECUTOR_CONTRACT_HASH } from './executor-contract.js';
import { InMemoryAuditLog } from './in-memory-audit-log.js';
import { InMemoryChangeSetRepository } from './in-memory-changeset-repository.js';
import { InMemoryExecutor, ScriptedWriter } from './in-memory-executor.js';

function build(
  opts: {
    batchSize?: number;
    wrap?: (r: InMemoryChangeSetRepository) => ChangeSetRepository;
    writer?: ScriptedWriter;
    rollbackWriter?: ScriptedWriter;
  } = {},
) {
  const audit = new InMemoryAuditLog();
  const base = new InMemoryChangeSetRepository(audit);
  const repository = opts.wrap?.(base) ?? base;
  const writer = opts.writer ?? new ScriptedWriter();
  const batchSize = opts.batchSize ?? 2;
  const failureThreshold = 0.5;
  const rollbackWriter = opts.rollbackWriter;
  const executor = new InMemoryExecutor({
    repository,
    writer,
    ...(rollbackWriter === undefined ? {} : { rollbackWriter }),
    batchSizeOf: () => batchSize,
    failureThreshold,
  });
  const prepared = async (items: number, o: { expiresAt?: Date; requester?: string } = {}): Promise<ChangeSetRecord> => {
    const id = randomUUID();
    const now = new Date();
    await repository.create(
      {
        id,
        operation: 'catalog.update',
        connection: 'shop',
        requester: o.requester ?? 'alice',
        args: {},
        configHash: 'cfg',
        correlationId: 'corr-prep',
        createdAt: now,
        expiresAt: o.expiresAt ?? new Date(now.getTime() + 86_400_000),
      },
      { id: randomUUID(), actor: 'alice', action: 'changeset.transition', outcome: 'ok', correlationId: 'corr-prep', changesetId: id, details: {} },
    );
    await repository.appendItems(
      id,
      Array.from({ length: items }, (_, i) => ({
        targetId: `t-${String(i + 1).padStart(4, '0')}`,
        status: 'pending' as const,
        before: { v: 1 },
        after: { v: 2 },
      })),
    );
    const stats = { ...EMPTY_STATS, ...(await repository.stats(id)) };
    const record = await repository.completePreparation(
      id,
      { status: 'prepared', hashVersion: 1, hash: EXECUTOR_CONTRACT_HASH, stats, preparedAt: now },
      { id: randomUUID(), actor: 'system', action: 'changeset.transition', outcome: 'ok', correlationId: 'corr-prep', changesetId: id, details: { from: 'preparing', to: 'prepared' } },
    );
    if (record === undefined) throw new Error('preparation failed');
    return record;
  };
  return { audit, repository, writer, batchSize, failureThreshold, executor, prepared };
}

describeExecutorContract('in-memory', () => {
  const h = build();
  return Promise.resolve({
    executor: h.executor,
    repository: h.repository,
    writer: h.writer,
    batchSize: h.batchSize,
    failureThreshold: h.failureThreshold,
    prepared: h.prepared,
    auditEvents: () => Promise.resolve([...h.audit.events]),
  });
});

describeRollbackRun('in-memory', () => {
  const rollbackWriter = new ScriptedWriter();
  const h = build({ rollbackWriter });
  return Promise.resolve({
    executor: h.executor,
    repository: h.repository,
    writer: h.writer,
    rollbackWriter,
    batchSize: h.batchSize,
    failureThreshold: h.failureThreshold,
    prepared: h.prepared,
    auditEvents: () => Promise.resolve([...h.audit.events]),
  });
});

const START = { expectedHash: EXECUTOR_CONTRACT_HASH, actor: 'alice', correlationId: 'c' };

describe('EXE-11 in-memory executor', () => {
  it('EXE-11 cancel during the first batch writes exactly that batch', async () => {
    const h = build();
    const cs = await h.prepared(6);
    const pause = h.writer.pauseAt(0);
    await h.executor.start({ changesetId: cs.id, ...START });
    await pause.reached;
    expect(await h.executor.cancel({ changesetId: cs.id, actor: 'bob', correlationId: 'c' })).toEqual({
      ok: true,
      status: 'executing',
    });
    pause.release();
    await h.executor.settled(cs.id);
    expect((await h.repository.get(cs.id))?.status).toBe('cancelled');
    expect(h.writer.batches).toHaveLength(1);
  });

  it('EXE-11 ignores outcomes for targets outside the batch and duplicate outcomes', async () => {
    const writer = new ScriptedWriter();
    writer.extraOutcomes = [
      { targetId: 'zzz', status: 'written' },
      { targetId: 't-0001', status: 'failed' },
    ];
    const h = build({ writer });
    const cs = await h.prepared(2);
    await h.executor.start({ changesetId: cs.id, ...START });
    await h.executor.settled(cs.id);
    const items = await h.repository.itemsPage(cs.id, { limit: 10 });
    expect(items.map((i) => i.status)).toEqual(['written', 'written']);
    expect((await h.repository.get(cs.id))?.status).toBe('completed');
  });

  it('EXE-11 an unexpected error fails the change-set with executor_error even with a stored cancel request', async () => {
    let thrown = false;
    const h = build({
      wrap: (r) =>
        new Proxy(r, {
          get(target, prop, receiver) {
            if (prop === 'completeBatch') {
              return (...args: Parameters<ChangeSetRepository['completeBatch']>) => {
                if (!thrown) {
                  thrown = true;
                  return Promise.reject(new Error('db down'));
                }
                return target.completeBatch(...args);
              };
            }
            return Reflect.get(target, prop, receiver) as unknown;
          },
        }),
    });
    const cs = await h.prepared(4);
    const pause = h.writer.pauseAt(0);
    await h.executor.start({ changesetId: cs.id, ...START });
    await pause.reached;
    expect(await h.executor.cancel({ changesetId: cs.id, actor: 'bob', correlationId: 'c' })).toEqual({
      ok: true,
      status: 'executing',
    });
    pause.release();
    await h.executor.settled(cs.id);
    const record = await h.repository.get(cs.id);
    expect(record?.status).toBe('failed');
    expect(record?.errorCode).toBe('executor_error');
    const failedEvents = h.audit.events.filter((e) => e.changesetId === cs.id && e.details.to === 'failed');
    expect(failedEvents).toHaveLength(1);
    expect(h.audit.events.filter((e) => e.changesetId === cs.id && e.details.to === 'cancelled')).toHaveLength(0);
  });

  it('NFR-2 a fenced submission ends the run failed/executor_error, not writer_error', async () => {
    const h = build({
      wrap: (r) =>
        new Proxy(r, {
          get(target, prop, receiver) {
            if (prop === 'recordSubmission') return () => Promise.resolve(false);
            return Reflect.get(target, prop, receiver) as unknown;
          },
        }),
    });
    const cs = await h.prepared(2);
    await h.executor.start({ changesetId: cs.id, ...START });
    await h.executor.settled(cs.id);
    const record = await h.repository.get(cs.id);
    expect(record?.status).toBe('failed');
    expect(record?.errorCode).toBe('executor_error');
  });

  it.each([0, 1.5, Number.NaN])('EXE-11 batch size %s fails the run with executor_error', async (size) => {
    const h = build({ batchSize: size });
    const cs = await h.prepared(2);
    await h.executor.start({ changesetId: cs.id, ...START });
    await h.executor.settled(cs.id);
    const record = await h.repository.get(cs.id);
    expect(record?.status).toBe('failed');
    expect(record?.errorCode).toBe('executor_error');
  });

  describe('EXE-12 EXE-11 verify-after', () => {
    // Now: the prepared change-sets expire a day after the real clock.
    const T0 = Date.now();
    const verifyAfter: ManifestVerifyAfter = {
      afterSeconds: 0,
      everySeconds: 30,
      timeoutSeconds: 600,
      checks: [{ code: 'not_live', require: [{ equals: [{ record: 'v' }, { after: 'v' }] }] }],
    };
    const manifest: ManifestDefinition = {
      idField: 'id',
      idsArg: 'ids',
      fields: ['v'],
      requiredFields: [],
      scopeArgs: {},
      readBefore: { operation: 'catalog.get', idsArg: 'ids', args: {} },
      batchSize: 2,
      maxTargets: 1000,
      rollback: { strategy: 'replay_previous_state' },
      verifyAfter,
    };

    /** Answers `v: 2` (the written value) from the `liveFromLook`-th look on, `v: 1` before. */
    class LookReader implements UpstreamReader {
      looks = 0;
      constructor(private readonly liveFromLook: number) {}
      read(_operationId: string, args: Readonly<Record<string, unknown>>): Promise<ReadPage> {
        const ids = Array.isArray(args.ids) ? (args.ids as string[]) : [];
        // One read per chunk; a look over two chunks counts once, at its first chunk.
        if (ids.includes('t-0001')) this.looks += 1;
        const v = this.looks >= this.liveFromLook ? 2 : 1;
        return Promise.resolve({ ok: true, items: ids.map((id) => ({ id, v })), truncated: false });
      }
    }

    /** A clock that only the injected sleep moves. */
    const fakeTime = () => {
      let t = T0;
      const sleeps: number[] = [];
      return {
        sleeps,
        now: () => new Date(t),
        sleep: (ms: number) => {
          sleeps.push(ms);
          t += ms;
          return Promise.resolve();
        },
      };
    };

    const verifyingBuild = (reader: UpstreamReader, time: ReturnType<typeof fakeTime>) => {
      const audit = new InMemoryAuditLog();
      const repository = new InMemoryChangeSetRepository(audit);
      const executor = new InMemoryExecutor({
        repository,
        writer: new ScriptedWriter(),
        batchSizeOf: () => 2,
        now: time.now,
        sleep: (ms) => time.sleep(ms),
        verification: { manifestOf: (op) => (op === 'catalog.update' ? manifest : undefined), reader, readFieldsArg: () => 'fields' },
      });
      return { audit, repository, executor };
    };

    const prepare = async (repository: ChangeSetRepository, items: number): Promise<ChangeSetRecord> => {
      const h = build({ wrap: () => repository });
      return h.prepared(items);
    };

    it('EXE-12 EXE-11 an item confirmed on the second look ends completed after one sleep of every_seconds', async () => {
      const time = fakeTime();
      const h = verifyingBuild(new LookReader(2), time);
      const cs = await prepare(h.repository, 3);
      await h.executor.start({ changesetId: cs.id, ...START });
      await h.executor.settled(cs.id);
      const record = await h.repository.get(cs.id);
      expect(record?.status).toBe('completed');
      expect(record?.stats.verification).toEqual({ pending: 0, confirmed: 3, unconfirmed: 0 });
      expect(time.sleeps).toEqual([verifyAfter.everySeconds * 1000]);
      const events = h.audit.events.filter((e) => e.changesetId === cs.id && e.action === 'changeset.verification');
      expect(events.map((e) => [e.actor, e.correlationId, e.details])).toEqual([
        ['system', 'c', { end: 'done', pending: 0, confirmed: 3, unconfirmed: 0, operation: 'catalog.update' }],
      ]);
    });

    it('EXE-12 EXE-11 an item never confirmed is unconfirmed once the clock passes the deadline: completed_with_errors', async () => {
      const time = fakeTime();
      const h = verifyingBuild(new LookReader(Number.POSITIVE_INFINITY), time);
      const cs = await prepare(h.repository, 2);
      await h.executor.start({ changesetId: cs.id, ...START });
      await h.executor.settled(cs.id);
      const record = await h.repository.get(cs.id);
      expect(record?.status).toBe('completed_with_errors');
      expect(record?.stats.verification).toEqual({ pending: 0, confirmed: 0, unconfirmed: 2 });
      expect(time.now().getTime()).toBeGreaterThanOrEqual(T0 + verifyAfter.timeoutSeconds * 1000);
      const items = await h.repository.itemsPage(cs.id, { limit: 10 });
      expect(items.map((i) => [i.status, i.verificationStatus, i.verificationCode])).toEqual([
        ['written', 'unconfirmed', 'not_live'],
        ['written', 'unconfirmed', 'not_live'],
      ]);
      const events = h.audit.events.filter((e) => e.changesetId === cs.id && e.action === 'changeset.verification');
      expect(events.map((e) => e.details.end)).toEqual(['timeout']);
    });

    it('EXE-12 EXE-7 a cancel stored during verification stops it: verify_cancelled, status from the items', async () => {
      const time = fakeTime();
      const reader = new LookReader(Number.POSITIVE_INFINITY);
      const h = verifyingBuild(reader, time);
      const cs = await prepare(h.repository, 2);
      const sleep = time.sleep;
      // The cancel arrives while the executor waits between looks.
      time.sleep = async (ms) => {
        await h.executor.cancel({ changesetId: cs.id, actor: 'bob', correlationId: 'corr-cancel' });
        return sleep(ms);
      };
      await h.executor.start({ changesetId: cs.id, ...START });
      await h.executor.settled(cs.id);
      expect(reader.looks).toBe(1);
      expect((await h.repository.get(cs.id))?.status).toBe('completed_with_errors');
      const items = await h.repository.itemsPage(cs.id, { limit: 10 });
      expect(items.map((i) => [i.verificationStatus, i.verificationCode])).toEqual([
        ['unconfirmed', 'not_live'],
        ['unconfirmed', 'not_live'],
      ]);
      const events = h.audit.events.filter((e) => e.changesetId === cs.id && e.action === 'changeset.verification');
      expect(events.map((e) => [e.actor, e.correlationId, e.details.end])).toEqual([['bob', 'corr-cancel', 'cancelled']]);
    });

    it('EXE-11 without the verification option nothing is verified', async () => {
      const h = build();
      const cs = await h.prepared(2);
      await h.executor.start({ changesetId: cs.id, ...START });
      await h.executor.settled(cs.id);
      const record = await h.repository.get(cs.id);
      expect(record?.status).toBe('completed');
      expect(record?.stats.verification).toBeUndefined();
    });
  });

  it('EXE-11 fills a batch larger than the repository page limit from several pages', async () => {
    const h = build({ batchSize: 600 });
    const cs = await h.prepared(1300);
    await h.executor.start({ changesetId: cs.id, ...START });
    await h.executor.settled(cs.id);
    expect(h.writer.batches.map((b) => b.length)).toEqual([600, 600, 100]);
    const all: readonly ChangeItemRecord[] = await h.repository.itemsPage(cs.id, { limit: 500, status: 'pending' });
    expect(all).toHaveLength(0);
    expect((await h.repository.get(cs.id))?.status).toBe('completed');
  });
});

describe('NFR-2 ScriptedWriter', () => {
  const changeset = { id: 'cs-1', operation: 'catalog.update' } as ChangeSetRecord;
  const item = (targetId: string): ChangeItemRecord => ({ targetId, status: 'pending', before: {}, after: {} });
  const context = (key: string, recorded: BatchSubmission[], submission?: BatchSubmission): BatchContext => ({
    key,
    ...(submission === undefined ? {} : { submission }),
    recordSubmission: (s) => {
      recorded.push(s);
      return Promise.resolve();
    },
    heartbeat: () => undefined,
  });

  it('NFR-2 ScriptedWriter.throwAt fails every attempt of the batch it names', async () => {
    const writer = new ScriptedWriter();
    writer.throwAt(1);
    const recorded: BatchSubmission[] = [];
    const first = [item('t-0001'), item('t-0002')];
    const second = [item('t-0003'), item('t-0004')];
    await expect(writer.writeBatch({ changeset, items: first, batch: context('k0', recorded) })).resolves.toHaveLength(2);
    await expect(writer.writeBatch({ changeset, items: second, batch: context('k1', recorded) })).rejects.toThrow();
    await expect(
      writer.writeBatch({ changeset, items: second, batch: context('k1', recorded, recorded[1]) }),
    ).rejects.toThrow();
    await expect(writer.writeBatch({ changeset, items: first, batch: context('k0', recorded) })).resolves.toHaveLength(2);
    expect(writer.calls).toBe(4);
  });

  it('NFR-2 ScriptedWriter records each batch once and resumes a recorded submission without writing again', async () => {
    const writer = new ScriptedWriter();
    const recorded: BatchSubmission[] = [];
    const items = [item('t-0001'), item('t-0002')];
    const first = await writer.writeBatch({ changeset, items, batch: context('cs-1:0', recorded) });
    expect(recorded).toEqual([
      {
        upstreamBatchId: 'cs-1:0',
        plan: [
          { targetId: 't-0001', action: 'write' },
          { targetId: 't-0002', action: 'write' },
        ],
      },
    ]);
    const resumed = await writer.writeBatch({ changeset, items, batch: context('cs-1:0', recorded, recorded[0]) });
    expect(resumed).toEqual(first);
    expect(writer.batches).toEqual([['t-0001', 't-0002']]);
    expect(recorded).toHaveLength(1);
    expect(writer.calls).toBe(2);
  });

  it('NFR-2 ScriptedWriter rethrows a fenced submission and pauses only the first call of a batch', async () => {
    const writer = new ScriptedWriter();
    const items = [item('t-0001')];
    const fenced: BatchContext = {
      key: 'k',
      recordSubmission: () => Promise.reject(new BatchFenced()),
      heartbeat: () => undefined,
    };
    await expect(writer.writeBatch({ changeset, items, batch: fenced })).rejects.toBeInstanceOf(BatchFenced);
    const pause = writer.pauseAt(0);
    const recorded: BatchSubmission[] = [];
    // The batch was already seen (first call above), so it is batch 0; its pause applies to the next call.
    const paused = writer.writeBatch({ changeset, items, batch: context('k', recorded) });
    await pause.reached;
    pause.release();
    await expect(paused).resolves.toHaveLength(1);
    await expect(writer.writeBatch({ changeset, items, batch: context('k', recorded, recorded[0]) })).resolves.toHaveLength(1);
  });
});
