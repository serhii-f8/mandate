import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuditEventInput, ChangeSetExecutor, ChangeSetRecord, ChangeSetRepository } from '@aiops/core';
import type { ScriptedWriter } from './in-memory-executor.js';

/**
 * One harness per case. A PostgreSQL repository may share one database across cases, so every
 * change-set uses a fresh UUID and audit assertions look only at events of the case's change-set.
 * Item target IDs are `t-0001`, `t-0002`, ... in every change-set.
 */
export interface ExecutorHarness {
  readonly executor: ChangeSetExecutor & { settled(id: string): Promise<void> };
  readonly repository: ChangeSetRepository;
  /** The writer the executor was built with; fresh per harness. */
  readonly writer: ScriptedWriter;
  /** The batch size the executor was built with (at least 2). */
  readonly batchSize: number;
  /** Creates a prepared change-set with `items` pending items; its hash is `EXECUTOR_CONTRACT_HASH`. */
  readonly prepared: (items: number, opts?: { expiresAt?: Date }) => Promise<ChangeSetRecord>;
  readonly auditEvents: () => Promise<readonly AuditEventInput[]>;
  readonly close?: () => Promise<void>;
}

export const EXECUTOR_CONTRACT_HASH = 'hash-fixed';

/** Behavior every ChangeSetExecutor implementation must have (EXE-11). */
export function describeExecutorContract(label: string, setup: () => Promise<ExecutorHarness>): void {
  describe(`EXE-11 executor contract: ${label}`, () => {
    async function withExec(body: (h: ExecutorHarness) => Promise<void>): Promise<void> {
      const h = await setup();
      try {
        await body(h);
      } finally {
        await h.close?.();
      }
    }
    const start = (h: ExecutorHarness, changesetId: string, expectedHash = EXECUTOR_CONTRACT_HASH) =>
      h.executor.start({ changesetId, expectedHash, actor: 'alice', correlationId: 'corr-exec' });
    const status = async (h: ExecutorHarness, id: string) => (await h.repository.get(id))?.status;

    it('EXE-11 refuses a wrong hash and leaves the status unchanged', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(2);
        expect(await start(h, cs.id, 'other')).toEqual({ ok: false, reason: 'hash_mismatch' });
        expect(await status(h, cs.id)).toBe('prepared');
      });
    });

    it('EXE-11 refuses an unknown change-set', async () => {
      await withExec(async (h) => {
        expect(await start(h, randomUUID())).toEqual({ ok: false, reason: 'not_found' });
        expect(await h.executor.progress(randomUUID())).toBeUndefined();
      });
    });

    it('EXE-11 expires a due change-set on start, with actor system', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(1, { expiresAt: new Date('2000-01-01T00:00:00Z') });
        expect(await start(h, cs.id)).toEqual({ ok: false, reason: 'expired' });
        expect(await status(h, cs.id)).toBe('expired');
        const events = (await h.auditEvents()).filter((e) => e.changesetId === cs.id && e.details.to === 'expired');
        expect(events.map((e) => e.actor)).toEqual(['system']);
      });
    });

    it('EXE-11 refuses a second start', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(2);
        expect(await start(h, cs.id)).toEqual({ ok: true });
        await h.executor.settled(cs.id);
        expect(await start(h, cs.id)).toEqual({ ok: false, reason: 'not_executable' });
      });
    });

    it('EXE-11 completes when every item is written and reports progress', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(5);
        expect(await start(h, cs.id)).toEqual({ ok: true });
        await h.executor.settled(cs.id);
        expect(await h.executor.progress(cs.id)).toEqual({
          status: 'completed',
          total: 5,
          done: 5,
          failed: 0,
          skipped: 0,
        });
      });
    });

    it('EXE-11 completes with errors when some items fail', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(3);
        h.writer.setOutcome('t-0002', 'failed');
        await start(h, cs.id);
        await h.executor.settled(cs.id);
        expect(await h.executor.progress(cs.id)).toEqual({
          status: 'completed_with_errors',
          total: 3,
          done: 2,
          failed: 1,
          skipped: 0,
        });
      });
    });

    it('EXE-11 fails when every item fails', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(2);
        h.writer.setOutcome('t-0001', 'failed');
        h.writer.setOutcome('t-0002', 'failed');
        await start(h, cs.id);
        await h.executor.settled(cs.id);
        expect(await status(h, cs.id)).toBe('failed');
      });
    });

    it('EXE-11 fails with writer_error when the writer throws', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(2);
        h.writer.throwAt(0);
        await start(h, cs.id);
        await h.executor.settled(cs.id);
        const record = await h.repository.get(cs.id);
        expect(record?.status).toBe('failed');
        expect(record?.errorCode).toBe('writer_error');
      });
    });

    it('EXE-11 counts skipped items', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(3);
        h.writer.setOutcome('t-0003', 'skipped');
        await start(h, cs.id);
        await h.executor.settled(cs.id);
        expect(await h.executor.progress(cs.id)).toEqual({
          status: 'completed',
          total: 3,
          done: 2,
          failed: 0,
          skipped: 1,
        });
      });
    });

    it('EXE-11 writes in batches no larger than the configured batch size', async () => {
      await withExec(async (h) => {
        const n = h.batchSize * 2 + 1;
        const cs = await h.prepared(n);
        await start(h, cs.id);
        await h.executor.settled(cs.id);
        expect(Math.max(...h.writer.batches.map((b) => b.length))).toBeLessThanOrEqual(h.batchSize);
        expect(h.writer.batches.flat()).toHaveLength(n);
        expect(new Set(h.writer.batches.flat()).size).toBe(n);
      });
    });

    it('EXE-11 cancel while a batch is in flight ends the run within one more batch', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(h.batchSize * 3);
        const pause = h.writer.pauseAt(0);
        await start(h, cs.id);
        await pause.reached;
        const cancelled = h.executor.cancel({ changesetId: cs.id, actor: 'bob', correlationId: 'corr-cancel' });
        pause.release();
        // A durable executor may answer while the run still drains (`executing`); the end state is what counts.
        const answer = await cancelled;
        expect(answer.ok).toBe(true);
        expect(answer.ok && ['executing', 'cancelled'].includes(answer.status)).toBe(true);
        await h.executor.settled(cs.id);
        expect(await status(h, cs.id)).toBe('cancelled');
        // A durable executor may let one more batch through after the request; never all three.
        expect(h.writer.batches.length).toBeLessThanOrEqual(2);
        const stored = await h.repository.get(cs.id);
        expect(stored?.stats.written).toBeGreaterThanOrEqual(h.batchSize);
        expect(stored?.stats.written).toBeLessThanOrEqual(h.batchSize * 2);
        const events = (await h.auditEvents()).filter((e) => e.changesetId === cs.id && e.details.to === 'cancelled');
        expect(events.map((e) => e.actor)).toEqual(['bob']);
      });
    });

    it('EXE-11 cancels a prepared change-set', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(1);
        expect(await h.executor.cancel({ changesetId: cs.id, actor: 'bob', correlationId: 'c' })).toEqual({
          ok: true,
          status: 'cancelled',
        });
        expect(await status(h, cs.id)).toBe('cancelled');
        expect(await h.executor.cancel({ changesetId: randomUUID(), actor: 'bob', correlationId: 'c' })).toEqual({
          ok: false,
          reason: 'not_found',
        });
      });
    });

    it('EXE-11 refuses to cancel a completed change-set', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(1);
        await start(h, cs.id);
        await h.executor.settled(cs.id);
        expect(await h.executor.cancel({ changesetId: cs.id, actor: 'bob', correlationId: 'c' })).toEqual({
          ok: false,
          reason: 'not_cancellable',
        });
        expect(await status(h, cs.id)).toBe('completed');
      });
    });

    const approve = async (h: ExecutorHarness, id: string) => {
      const ev = (to: string) => ({
        id: randomUUID(),
        actor: 'carol',
        action: 'changeset.transition' as const,
        outcome: 'ok' as const,
        correlationId: 'corr-approve',
        changesetId: id,
        details: { to },
      });
      await h.repository.transition(id, ['prepared'], 'pending_approval', ev('pending_approval'));
      await h.repository.transition(id, ['pending_approval'], 'approved', ev('approved'));
    };
    const transitionActors = async (h: ExecutorHarness, id: string, to: string) =>
      (await h.auditEvents()).filter((e) => e.changesetId === id && e.details.to === to).map((e) => e.actor);

    it('EXE-11 records a dropped outcome as failed no_outcome and writes each item at most once', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(3);
        h.writer.dropOutcome('t-0002');
        await start(h, cs.id);
        await h.executor.settled(cs.id);
        const items = await h.repository.itemsPage(cs.id, { limit: 10 });
        expect(items.map((i) => [i.targetId, i.status, i.error])).toEqual([
          ['t-0001', 'written', undefined],
          ['t-0002', 'failed', 'no_outcome'],
          ['t-0003', 'written', undefined],
        ]);
        expect(await status(h, cs.id)).toBe('completed_with_errors');
        const written = h.writer.batches.flat();
        expect(new Set(written).size).toBe(written.length);
      });
    });

    it('EXE-11 starts from approved', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(2);
        await approve(h, cs.id);
        expect(await start(h, cs.id)).toEqual({ ok: true });
        await h.executor.settled(cs.id);
        expect(await status(h, cs.id)).toBe('completed');
      });
    });

    it('EXE-11 refuses to start a cancelled or expired change-set', async () => {
      await withExec(async (h) => {
        const a = await h.prepared(1);
        await h.executor.cancel({ changesetId: a.id, actor: 'bob', correlationId: 'c' });
        expect(await start(h, a.id)).toEqual({ ok: false, reason: 'not_executable' });
        const b = await h.prepared(1, { expiresAt: new Date('2000-01-01T00:00:00Z') });
        expect(await start(h, b.id)).toEqual({ ok: false, reason: 'expired' });
        expect(await start(h, b.id)).toEqual({ ok: false, reason: 'not_executable' });
      });
    });

    it('EXE-11 refuses to start a change-set that is still preparing as not executable', async () => {
      await withExec(async (h) => {
        const id = randomUUID();
        await h.repository.create(
          {
            id,
            operation: 'catalog.update',
            connection: 'shop',
            requester: 'alice',
            args: {},
            configHash: 'cfg',
            correlationId: 'corr-exec',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 3_600_000),
          },
          {
            id: randomUUID(),
            actor: 'alice',
            action: 'changeset.transition',
            outcome: 'ok',
            correlationId: 'corr-exec',
            changesetId: id,
            details: {},
          },
        );
        expect(await start(h, id)).toEqual({ ok: false, reason: 'not_executable' });
        expect(await status(h, id)).toBe('preparing');
      });
    });

    it('EXE-11 reports expired before a hash mismatch', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(1, { expiresAt: new Date('2000-01-01T00:00:00Z') });
        expect(await start(h, cs.id, 'wrong')).toEqual({ ok: false, reason: 'expired' });
      });
    });

    it('EXE-11 completes a change-set without pending items', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(0);
        expect(await start(h, cs.id)).toEqual({ ok: true });
        await h.executor.settled(cs.id);
        expect(await status(h, cs.id)).toBe('completed');
        expect(h.writer.batches).toHaveLength(0);
      });
    });

    it('EXE-11 keeps earlier batch outcomes when the writer throws on a later batch', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(h.batchSize * 2 + 1);
        h.writer.throwAt(1);
        await start(h, cs.id);
        await h.executor.settled(cs.id);
        const record = await h.repository.get(cs.id);
        expect(record?.status).toBe('failed');
        expect(record?.errorCode).toBe('writer_error');
        expect(record?.stats.written).toBe(h.batchSize);
        expect((await transitionActors(h, cs.id, 'failed')).length).toBe(1);
      });
    });

    it('EXE-11 cancels an approved change-set', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(1);
        await approve(h, cs.id);
        expect(await h.executor.cancel({ changesetId: cs.id, actor: 'bob', correlationId: 'c' })).toEqual({
          ok: true,
          status: 'cancelled',
        });
        expect(await transitionActors(h, cs.id, 'cancelled')).toEqual(['bob']);
      });
    });

    it('EXE-11 audits every transition', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(1);
        await start(h, cs.id);
        await h.executor.settled(cs.id);
        const transitions = (await h.auditEvents())
          .filter((e) => e.changesetId === cs.id && e.action === 'changeset.transition')
          .map((e) => `${String(e.details.from)}>${String(e.details.to)}`);
        expect(transitions).toEqual(expect.arrayContaining(['prepared>executing', 'executing>completed']));
        const exec = (await h.auditEvents()).find((e) => e.changesetId === cs.id && e.details.to === 'executing');
        expect(exec?.actor).toBe('alice');
        expect(exec?.correlationId).toBe('corr-exec');
      });
    });
  });
}
