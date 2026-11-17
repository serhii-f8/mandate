import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  AuditEventInput,
  ChangeSetExecutor,
  ChangeSetRecord,
  ChangeSetRepository,
  ExecutionLimits,
} from '@aiops/core';
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
  /** The failure threshold the executor was built with (below 1). */
  readonly failureThreshold: number;
  /**
   * Creates a prepared change-set with `items` pending items; its hash is `EXECUTOR_CONTRACT_HASH`.
   * The requester defaults to `alice`.
   */
  readonly prepared: (items: number, opts?: { expiresAt?: Date; requester?: string }) => Promise<ChangeSetRecord>;
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
    const startWith = (
      h: ExecutorHarness,
      changesetId: string,
      opts: { limits?: ExecutionLimits; groups?: readonly string[] },
    ) =>
      h.executor.start({
        changesetId,
        expectedHash: EXECUTOR_CONTRACT_HASH,
        actor: 'alice',
        correlationId: 'corr-exec',
        ...opts,
      });
    // Limits count per requester; a fresh one per case keeps a shared database from adding up usage.
    const freshRequester = () => `alice-${randomUUID()}`;

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

    it('POL-4 refuses a start over records_per_operation, audits the deny and leaves the change-set prepared', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(3, { requester: freshRequester() });
        expect(await startWith(h, cs.id, { limits: { role: 'editor', recordsPerOperation: 2 } })).toEqual({
          ok: false,
          reason: 'limit_exceeded',
          limit: 'records_per_operation',
        });
        expect(await status(h, cs.id)).toBe('prepared');
        const denies = (await h.auditEvents()).filter(
          (e) => e.changesetId === cs.id && e.action === 'policy.decision',
        );
        expect(denies.map((e) => [e.outcome, e.details.reason])).toEqual([['denied', 'limit_exceeded']]);
        expect(h.writer.calls).toBe(0);
      });
    });

    it('POL-4 refuses a start over concurrent_executions while another run of the requester executes', async () => {
      await withExec(async (h) => {
        const requester = freshRequester();
        const a = await h.prepared(h.batchSize * 2, { requester });
        const b = await h.prepared(1, { requester });
        const pause = h.writer.pauseAt(0);
        expect(await start(h, a.id)).toEqual({ ok: true });
        await pause.reached;
        expect(await startWith(h, b.id, { limits: { role: 'editor', concurrentExecutions: 1 } })).toEqual({
          ok: false,
          reason: 'limit_exceeded',
          limit: 'concurrent_executions',
        });
        pause.release();
        await h.executor.settled(a.id);
        expect(await status(h, a.id)).toBe('completed');
        expect(await status(h, b.id)).toBe('prepared');
      });
    });

    it('POL-4 refuses a start over records_per_day', async () => {
      await withExec(async (h) => {
        const requester = freshRequester();
        const a = await h.prepared(3, { requester });
        const b = await h.prepared(2, { requester });
        expect(await start(h, a.id)).toEqual({ ok: true });
        await h.executor.settled(a.id);
        expect(await startWith(h, b.id, { limits: { role: 'editor', recordsPerDay: 4 } })).toEqual({
          ok: false,
          reason: 'limit_exceeded',
          limit: 'records_per_day',
        });
        expect(await status(h, b.id)).toBe('prepared');
      });
    });

    it("POL-6 stores the execution request with the starter's groups", async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(1);
        expect(await startWith(h, cs.id, { groups: ['g1'] })).toEqual({ ok: true });
        await h.executor.settled(cs.id);
        const request = (await h.repository.get(cs.id))?.executionRequest;
        expect(request?.groups).toEqual(['g1']);
        expect(request?.actor).toBe('alice');
        expect(request?.correlationId).toBe('corr-exec');
      });
    });

    it('EXE-5 stops remaining batches when the failure rate exceeds the threshold', async () => {
      await withExec(async (h) => {
        expect(h.failureThreshold).toBeLessThan(1);
        const cs = await h.prepared(h.batchSize * 3);
        for (let i = 1; i <= h.batchSize; i++) h.writer.setOutcome(`t-${String(i).padStart(4, '0')}`, 'failed');
        await start(h, cs.id);
        await h.executor.settled(cs.id);
        const record = await h.repository.get(cs.id);
        expect(record?.status).toBe('failed');
        expect(record?.errorCode).toBe('failure_threshold');
        expect(h.writer.batches).toHaveLength(1);
        expect(record?.stats.failed).toBe(h.batchSize);
        const pending = await h.repository.itemsPage(cs.id, { status: 'pending', limit: 500 });
        expect(pending).toHaveLength(2 * h.batchSize);
      });
    });

    it('EXE-7 stores the first cancel request of an executing change-set and ends cancelled by its actor', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(h.batchSize * 3);
        const pause = h.writer.pauseAt(0);
        await start(h, cs.id);
        await pause.reached;
        expect(await h.executor.cancel({ changesetId: cs.id, actor: 'bob', correlationId: 'corr-bob' })).toEqual({
          ok: true,
          status: 'executing',
        });
        expect(await h.executor.cancel({ changesetId: cs.id, actor: 'carol', correlationId: 'corr-carol' })).toEqual({
          ok: true,
          status: 'executing',
        });
        const stored = (await h.repository.get(cs.id))?.cancelRequest;
        expect(stored?.actor).toBe('bob');
        expect(stored?.correlationId).toBe('corr-bob');
        pause.release();
        await h.executor.settled(cs.id);
        expect(await status(h, cs.id)).toBe('cancelled');
        const events = (await h.auditEvents()).filter((e) => e.changesetId === cs.id && e.details.to === 'cancelled');
        expect(events.map((e) => [e.actor, e.correlationId])).toEqual([['bob', 'corr-bob']]);
      });
    });

    it('AUD-1 EXE-3 audits one changeset.batch event per batch with counts and no values', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(2 * h.batchSize + 1);
        h.writer.setOutcome('t-0001', 'failed');
        await start(h, cs.id);
        await h.executor.settled(cs.id);
        const batches = (await h.auditEvents()).filter(
          (e) => e.changesetId === cs.id && e.action === 'changeset.batch',
        );
        expect(batches.map((e) => e.details.batchNo)).toEqual([0, 1, 2]);
        for (const e of batches) {
          expect(Object.keys(e.details).sort()).toEqual(['batchNo', 'failed', 'operation', 'skipped', 'written']);
          expect(e.actor).toBe('system');
          expect(e.correlationId).toBe('corr-exec');
        }
        expect(batches.map((e) => [e.details.written, e.details.failed])).toEqual([
          [h.batchSize - 1, 1],
          [h.batchSize, 0],
          [1, 0],
        ]);
      });
    });

    it('EXE-5 EXE-6 a run whose last batch fails every item finishes done: failed without an error code', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(h.batchSize);
        for (let i = 1; i <= h.batchSize; i++) h.writer.setOutcome(`t-${String(i).padStart(4, '0')}`, 'failed');
        await start(h, cs.id);
        await h.executor.settled(cs.id);
        const record = await h.repository.get(cs.id);
        expect(record?.status).toBe('failed');
        expect(record?.errorCode).toBeUndefined();
      });
    });

    it('EXE-7 a cancel stored while the final batch is in flight ends completed', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(h.batchSize);
        const pause = h.writer.pauseAt(0);
        await start(h, cs.id);
        await pause.reached;
        expect(await h.executor.cancel({ changesetId: cs.id, actor: 'bob', correlationId: 'corr-bob' })).toEqual({
          ok: true,
          status: 'executing',
        });
        pause.release();
        await h.executor.settled(cs.id);
        const record = await h.repository.get(cs.id);
        expect(record?.status).toBe('completed');
        expect(record?.stats.written).toBe(h.batchSize);
      });
    });

    it('EXE-7 EXE-5 a stored cancel wins over an exceeded failure threshold while work remains', async () => {
      await withExec(async (h) => {
        const cs = await h.prepared(h.batchSize * 3);
        for (let i = 1; i <= h.batchSize; i++) h.writer.setOutcome(`t-${String(i).padStart(4, '0')}`, 'failed');
        const pause = h.writer.pauseAt(0);
        await start(h, cs.id);
        await pause.reached;
        await h.executor.cancel({ changesetId: cs.id, actor: 'bob', correlationId: 'corr-bob' });
        pause.release();
        await h.executor.settled(cs.id);
        const record = await h.repository.get(cs.id);
        expect(record?.status).toBe('cancelled');
        expect(record?.errorCode).toBeUndefined();
        expect(h.writer.batches).toHaveLength(1);
      });
    });
  });
}
