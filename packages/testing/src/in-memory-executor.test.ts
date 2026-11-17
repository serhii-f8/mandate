import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATS,
  type ChangeItemRecord,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type ItemOutcome,
} from '@aiops/core';
import { describeExecutorContract, EXECUTOR_CONTRACT_HASH } from './executor-contract.js';
import { InMemoryAuditLog } from './in-memory-audit-log.js';
import { InMemoryChangeSetRepository } from './in-memory-changeset-repository.js';
import { InMemoryExecutor, ScriptedWriter } from './in-memory-executor.js';

function build(
  opts: { batchSize?: number; wrap?: (r: InMemoryChangeSetRepository) => ChangeSetRepository; writer?: ScriptedWriter } = {},
) {
  const audit = new InMemoryAuditLog();
  const base = new InMemoryChangeSetRepository(audit);
  const repository = opts.wrap?.(base) ?? base;
  const writer = opts.writer ?? new ScriptedWriter();
  const batchSize = opts.batchSize ?? 2;
  const executor = new InMemoryExecutor({ repository, writer, batchSizeOf: () => batchSize });
  const prepared = async (items: number, o: { expiresAt?: Date } = {}): Promise<ChangeSetRecord> => {
    const id = randomUUID();
    const now = new Date();
    await repository.create(
      {
        id,
        operation: 'catalog.update',
        connection: 'shop',
        requester: 'alice',
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
      { status: 'prepared', hash: EXECUTOR_CONTRACT_HASH, stats, preparedAt: now },
      { id: randomUUID(), actor: 'system', action: 'changeset.transition', outcome: 'ok', correlationId: 'corr-prep', changesetId: id, details: { from: 'preparing', to: 'prepared' } },
    );
    if (record === undefined) throw new Error('preparation failed');
    return record;
  };
  return { audit, repository, writer, batchSize, executor, prepared };
}

describeExecutorContract('in-memory', () => {
  const h = build();
  return Promise.resolve({
    executor: h.executor,
    repository: h.repository,
    writer: h.writer,
    batchSize: h.batchSize,
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
    const cancelled = h.executor.cancel({ changesetId: cs.id, actor: 'bob', correlationId: 'c' });
    pause.release();
    expect(await cancelled).toEqual({ ok: true, status: 'cancelled' });
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

  it('EXE-11 an unexpected error fails the change-set with executor_error and cancel does not claim success', async () => {
    let thrown = false;
    const h = build({
      wrap: (r) =>
        new Proxy(r, {
          get(target, prop, receiver) {
            if (prop === 'recordItemOutcomes') {
              return (id: string, outcomes: readonly ItemOutcome[]) => {
                if (!thrown) {
                  thrown = true;
                  return Promise.reject(new Error('db down'));
                }
                return target.recordItemOutcomes(id, outcomes);
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
    const cancelled = h.executor.cancel({ changesetId: cs.id, actor: 'bob', correlationId: 'c' });
    pause.release();
    expect(await cancelled).toEqual({ ok: false, reason: 'not_cancellable' });
    const record = await h.repository.get(cs.id);
    expect(record?.status).toBe('failed');
    expect(record?.errorCode).toBe('executor_error');
    const failedEvents = h.audit.events.filter((e) => e.changesetId === cs.id && e.details.to === 'failed');
    expect(failedEvents).toHaveLength(1);
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

  it('EXE-11 lazy expiry that loses the race continues with the normal checks', async () => {
    const h = build({
      wrap: (r) =>
        new Proxy(r, {
          get(target, prop, receiver) {
            if (prop === 'transition') {
              return async (id: string, from: never, to: string, audit: never, extra: never) => {
                if (to === 'expired') {
                  await target.transition(id, ['prepared'], 'cancelled', { ...(audit as object), id: randomUUID() } as never);
                  return undefined;
                }
                return target.transition(id, from, to as never, audit, extra);
              };
            }
            return Reflect.get(target, prop, receiver) as unknown;
          },
        }),
    });
    const cs = await h.prepared(1, { expiresAt: new Date('2000-01-01T00:00:00Z') });
    expect(await h.executor.start({ changesetId: cs.id, ...START })).toEqual({ ok: false, reason: 'not_executable' });
    expect((await h.repository.get(cs.id))?.status).toBe('cancelled');
  });
});
