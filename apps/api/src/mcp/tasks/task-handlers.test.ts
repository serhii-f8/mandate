import { describe, expect, it, vi } from 'vitest';
import { ProtocolError } from '@modelcontextprotocol/server';
import {
  ExecutorUnavailable,
  TASK_TTL_MS,
  type Caller,
  type ChangeSetExecutor,
  type ChangeSetStatus,
  type ExecutionProgress,
  type TaskKind,
} from '@aiops/core';
import { InMemoryAuditLog, InMemoryChangeSetRepository, InMemoryTaskRepository } from '@aiops/testing';
import { createTaskHandlers, type TaskRequestContext } from './task-handlers.js';

const alice: Caller = { subject: 'alice', groups: [] };
const bob: Caller = { subject: 'bob', groups: [] };
const CS = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const UNKNOWN = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-01-01T12:00:00Z');
const STATS = { total: 25, included: 25, excluded: {}, written: 0, failed: 0, skipped: 0 };

type CancelAnswer = Awaited<ReturnType<ChangeSetExecutor['cancel']>>;

class StubExecutor implements ChangeSetExecutor {
  readonly cancels: Parameters<ChangeSetExecutor['cancel']>[0][] = [];
  cancelAnswer: CancelAnswer = { ok: true, status: 'executing' };
  progressAnswer: ExecutionProgress | undefined;
  /** When set, `cancel` and `progress` reject with it (an unreachable executor). */
  failure: Error | undefined;

  start(): ReturnType<ChangeSetExecutor['start']> {
    return Promise.reject(new Error('not used'));
  }

  cancel(req: Parameters<ChangeSetExecutor['cancel']>[0]): Promise<CancelAnswer> {
    this.cancels.push(req);
    return this.failure === undefined ? Promise.resolve(this.cancelAnswer) : Promise.reject(this.failure);
  }

  wake(): Promise<void> {
    return Promise.resolve();
  }

  progress(): Promise<ExecutionProgress | undefined> {
    return this.failure === undefined ? Promise.resolve(this.progressAnswer) : Promise.reject(this.failure);
  }
}

type Stage = 'preparing' | 'prepared' | 'executing' | 'completed';

async function setup(kind: TaskKind, stage: Stage) {
  const repository = new InMemoryChangeSetRepository();
  const tasks = new InMemoryTaskRepository();
  const audit = new InMemoryAuditLog();
  const executor = new StubExecutor();
  const event = { id: 'a0', actor: 'alice', action: 'changeset.transition' as const, outcome: 'ok' as const, correlationId: 'c0', details: {} };
  await repository.create(
    { id: CS, operation: 'shop.update_content', connection: 'shop', requester: 'alice', args: {}, configHash: 'h', correlationId: 'c0', createdAt: NOW, expiresAt: new Date('2026-01-02T12:00:00Z') },
    event,
  );
  if (stage !== 'preparing') {
    const targets = Array.from({ length: 25 }, (_, i) => `t${String(i).padStart(2, '0')}`);
    await repository.appendItems(CS, targets.map((targetId) => ({ targetId, status: 'pending' as const, before: null, after: null })));
    await repository.completePreparation(CS, { status: 'prepared', hash: 'sha256:x', stats: STATS, preparedAt: NOW }, { ...event, id: 'a1' });
  }
  const move = async (from: ChangeSetStatus, to: ChangeSetStatus) => {
    if ((await repository.transition(CS, [from], to, { ...event, id: `t-${to}` })) === undefined) throw new Error(`transition to ${to} failed`);
  };
  if (stage === 'executing' || stage === 'completed') await move('prepared', 'executing');
  if (stage === 'completed') {
    await repository.recordItemOutcomes(CS, [
      { targetId: 't00', status: 'written' },
      { targetId: 't01', status: 'skipped', error: 'drift' },
    ]);
    await move('executing', 'completed');
  }
  const createdAt = new Date('2026-01-01T12:00:01.000Z');
  await tasks.create({ taskId: TASK, owner: 'alice', changesetId: CS, kind, tool: 'shop.update_content', createdAt, ttlMs: TASK_TTL_MS });
  let n = 0;
  const handlers = createTaskHandlers({ tasks, repository, executor, audit, newId: () => `audit-${String(++n)}` });
  const ctx = (caller: Caller, declared = true): TaskRequestContext => ({ caller, correlationId: 'corr-7', declared });
  return { repository, tasks, audit, executor, handlers, ctx, createdAt };
}

async function rejection(p: Promise<unknown>): Promise<ProtocolError> {
  const error: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ProtocolError)) throw new Error(`expected a ProtocolError, got ${String(error)}`);
  return error;
}

function text(result: { content: unknown[] } | undefined): string {
  return (result?.content ?? []).map((c) => (c as { text?: string }).text ?? '').join('\n');
}

describe('MCP-7 SEC-1 AUD-1 task handlers', () => {
  it('MCP-7 tasks/get of an unknown task answers -32602 Task not found', async () => {
    const { handlers, ctx } = await setup('prepare', 'preparing');
    const error = await rejection(handlers.get({ taskId: UNKNOWN }, ctx(alice)));
    expect(error.code).toBe(-32602);
    expect(error.message).toBe('Failed to retrieve task: Task not found');
  });

  it("SEC-1 tasks/get of another user's task answers -32602 while the owner reads it", async () => {
    const { handlers, ctx } = await setup('prepare', 'preparing');
    await expect(handlers.get({ taskId: TASK }, ctx(alice))).resolves.toMatchObject({ taskId: TASK });
    const error = await rejection(handlers.get({ taskId: TASK }, ctx(bob)));
    expect(error.code).toBe(-32602);
    expect(error.message).toBe('Failed to retrieve task: Task not found');
  });

  it('SEC-1 malformed task IDs answer -32602 without a change-set lookup', async () => {
    const { handlers, ctx, repository } = await setup('prepare', 'prepared');
    const get = vi.spyOn(repository, 'get');
    for (const taskId of ['x', 'x'.repeat(5000)]) {
      const error = await rejection(handlers.get({ taskId }, ctx(alice)));
      expect(error.code).toBe(-32602);
      expect(error.message).toBe('Failed to retrieve task: Task not found');
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('MCP-7 a request without the declaration answers -32021', async () => {
    const { handlers, ctx, executor, audit } = await setup('execute', 'executing');
    const calls = [handlers.get.bind(handlers), handlers.update.bind(handlers), handlers.cancel.bind(handlers)];
    for (const call of calls) {
      const error = await rejection(call({ taskId: TASK }, ctx(alice, false)));
      expect(error.code).toBe(-32021);
    }
    expect(executor.cancels).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('MCP-7 a working prepare task carries ttlMs 604800000 and pollIntervalMs 2000', async () => {
    const { handlers, ctx, repository, createdAt } = await setup('prepare', 'preparing');
    const record = await repository.get(CS);
    const answer = await handlers.get({ taskId: TASK }, ctx(alice));
    expect(answer).toEqual({
      resultType: 'complete',
      taskId: TASK,
      status: 'working',
      createdAt: createdAt.toISOString(),
      lastUpdatedAt: record?.updatedAt?.toISOString(),
      ttlMs: 604800000,
      pollIntervalMs: 2000,
    });
  });

  it('MCP-7 a completed prepare task carries the prepared result', async () => {
    const { handlers, ctx } = await setup('prepare', 'prepared');
    const answer = await handlers.get({ taskId: TASK }, ctx(alice));
    expect(answer.status).toBe('completed');
    const result = answer.result;
    expect(result?.resultType).toBe('complete');
    const structured = result?.structuredContent as { changeset: { hash?: string }; items: unknown[] };
    expect(structured.changeset.hash).toBe('sha256:x');
    expect(structured.items.length).toBeLessThanOrEqual(20);
    expect(result).not.toHaveProperty('isError');
  });

  it('MCP-7 EXE-6 a working execute task reports progress in statusMessage', async () => {
    const { handlers, ctx, executor } = await setup('execute', 'executing');
    executor.progressAnswer = { status: 'executing', total: 10, done: 4, failed: 1, skipped: 0 };
    const answer = await handlers.get({ taskId: TASK }, ctx(alice));
    expect(answer.status).toBe('working');
    expect(answer.statusMessage).toBe('4 of 10 done, 1 failed, 0 skipped');
    expect(answer).not.toHaveProperty('result');
  });

  it('MCP-7 EXE-6 a working execute task omits statusMessage when the executor is unavailable', async () => {
    const { handlers, ctx, executor } = await setup('execute', 'executing');
    executor.failure = new ExecutorUnavailable();
    const answer = await handlers.get({ taskId: TASK }, ctx(alice));
    expect(answer.status).toBe('working');
    expect(answer).not.toHaveProperty('statusMessage');
  });

  it('MCP-7 CS-7 a completed execute task carries the execution summary', async () => {
    const { handlers, ctx, repository } = await setup('execute', 'completed');
    expect(await repository.errorCounts(CS)).toEqual({ drift: 1 });
    const answer = await handlers.get({ taskId: TASK }, ctx(alice));
    expect(answer.status).toBe('completed');
    expect(answer.result?.resultType).toBe('complete');
    const summary = text(answer.result);
    expect(summary.startsWith('completed: ')).toBe(true);
    expect(summary.endsWith('(1 changed upstream since preparation).')).toBe(true);
  });

  it('MCP-7 AUD-1 tasks/cancel calls executor.cancel as the caller and audits task.cancel', async () => {
    const { handlers, ctx, executor, audit } = await setup('execute', 'executing');
    const answer = await handlers.cancel({ taskId: TASK }, ctx(alice));
    expect(answer).toEqual({ resultType: 'complete' });
    expect(executor.cancels).toEqual([{ changesetId: CS, actor: 'alice', correlationId: 'corr-7' }]);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ action: 'task.cancel', actor: 'alice', correlationId: 'corr-7', changesetId: CS, details: { taskId: TASK } });
  });

  it('MCP-7 AUD-1 tasks/cancel is acknowledged and audited as executor_unavailable when the executor is unavailable', async () => {
    const { handlers, ctx, executor, audit } = await setup('execute', 'executing');
    executor.failure = new ExecutorUnavailable();
    const answer = await handlers.cancel({ taskId: TASK }, ctx(alice));
    expect(answer).toEqual({ resultType: 'complete' });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      action: 'task.cancel',
      outcome: 'error',
      changesetId: CS,
      details: { taskId: TASK, reason: 'executor_unavailable' },
    });
  });

  it('SEC-1 tasks/cancel of a foreign task answers -32602, does not call the executor and writes no audit row', async () => {
    const { handlers, ctx, executor, audit } = await setup('execute', 'executing');
    const error = await rejection(handlers.cancel({ taskId: TASK }, ctx(bob)));
    expect(error.code).toBe(-32602);
    expect(executor.cancels).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('MCP-7 AUD-1 tasks/cancel of a completed task is acknowledged and audited and leaves the status', async () => {
    const { handlers, ctx, executor, audit } = await setup('execute', 'completed');
    const answer = await handlers.cancel({ taskId: TASK }, ctx(alice));
    expect(answer).toEqual({ resultType: 'complete' });
    expect(executor.cancels).toEqual([]);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ action: 'task.cancel', outcome: 'error', changesetId: CS, details: { taskId: TASK, reason: 'not_cancellable' } });
    expect((await handlers.get({ taskId: TASK }, ctx(alice))).status).toBe('completed');
  });

  for (const stage of ['prepared', 'executing'] as const) {
    it(`MCP-7 AUD-1 tasks/cancel of a completed prepare task on a ${stage} change-set never reaches the executor`, async () => {
      const { handlers, ctx, executor, audit, repository } = await setup('prepare', stage);
      const answer = await handlers.cancel({ taskId: TASK }, ctx(alice));
      expect(answer).toEqual({ resultType: 'complete' });
      expect(executor.cancels).toEqual([]);
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({
        action: 'task.cancel',
        outcome: 'error',
        changesetId: CS,
        details: { taskId: TASK, reason: 'not_cancellable' },
      });
      expect((await repository.get(CS))?.status).toBe(stage);
      expect((await handlers.get({ taskId: TASK }, ctx(alice))).status).toBe('completed');
    });
  }

  it('MCP-7 tasks/cancel of a working prepare task reaches the executor', async () => {
    const { handlers, ctx, executor } = await setup('prepare', 'preparing');
    await handlers.cancel({ taskId: TASK }, ctx(alice));
    expect(executor.cancels).toEqual([{ changesetId: CS, actor: 'alice', correlationId: 'corr-7' }]);
  });

  it('MCP-7 SEC-1 tasks/update acknowledges an owned task and answers -32602 for a foreign one', async () => {
    const { handlers, ctx, audit } = await setup('prepare', 'preparing');
    await expect(handlers.update({ taskId: TASK }, ctx(alice))).resolves.toEqual({ resultType: 'complete' });
    const error = await rejection(handlers.update({ taskId: TASK }, ctx(bob)));
    expect(error.code).toBe(-32602);
    expect(audit.events).toEqual([]);
  });
});
