/**
 * `tasks/get`, `tasks/update` and `tasks/cancel` of the Tasks extension (MCP-7). Every request
 * must declare the extension, and the task must belong to the caller (SEC-1): unknown, foreign and
 * malformed IDs all answer "Task not found" with no side effect. The status is derived from the
 * change-set on every read, so any `api` instance answers (NFR-3). Only `tasks/cancel` is audited
 * (AUD-1); polling would flood the audit.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  ExecutorUnavailable,
  isTaskId,
  type AuditLog,
  type Caller,
  type ChangeSetExecutor,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type InvocationResult,
  type TaskRecord,
  type TaskRepository,
} from '@aiops/core';
import {
  executionAnswer,
  expiredDuringPreparationAnswer,
  preparationErrorAnswer,
  preparedAnswer,
  toCallToolResult,
} from '../../changesets/results.js';
import { missingTasksCapability, taskNotFound } from './extension.js';
import { TASK_POLL_INTERVAL_MS } from './task-result.js';
import { deriveTaskState, type TaskState } from './task-state.js';

export interface TaskHandlerDeps {
  readonly tasks: TaskRepository;
  readonly repository: ChangeSetRepository;
  readonly executor: ChangeSetExecutor;
  readonly audit: AuditLog;
  readonly newId: () => string;
}

export interface TaskRequestContext {
  readonly caller: Caller;
  readonly correlationId: string;
  /** Whether this request's `_meta` declares the Tasks extension. */
  readonly declared: boolean;
}

export interface GetTaskResult {
  resultType: 'complete';
  taskId: string;
  status: 'working' | 'completed' | 'cancelled';
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
  result?: CallToolResult & { resultType: 'complete' };
}

export interface TaskHandlers {
  get(params: { taskId: string }, ctx: TaskRequestContext): Promise<GetTaskResult>;
  update(params: { taskId: string }, ctx: TaskRequestContext): Promise<{ resultType: 'complete' }>;
  cancel(params: { taskId: string }, ctx: TaskRequestContext): Promise<{ resultType: 'complete' }>;
}

const ACK = { resultType: 'complete' } as const;

export function createTaskHandlers(deps: TaskHandlerDeps): TaskHandlers {
  /** The declaration first, then the owned task; nothing else is read for a refused request. */
  async function owned(taskId: string, ctx: TaskRequestContext): Promise<TaskRecord> {
    if (!ctx.declared) throw missingTasksCapability();
    // A non-UUID never reaches the store (ADR 0029 ruling b).
    if (!isTaskId(taskId)) throw taskNotFound();
    const task = await deps.tasks.findOwned(taskId, ctx.caller.subject);
    if (task === undefined) throw taskNotFound();
    return task;
  }

  async function answerOf(state: TaskState, record: ChangeSetRecord): Promise<InvocationResult | undefined> {
    switch (state.answer) {
      case 'prepared':
        return preparedAnswer(deps.repository, record);
      case 'preparation_error':
        return preparationErrorAnswer(record);
      case 'expired':
        return expiredDuringPreparationAnswer(record);
      case 'execution':
        return executionAnswer(record, await deps.repository.errorCounts(record.id));
      default:
        return undefined;
    }
  }

  async function statusMessageOf(task: TaskRecord, state: TaskState): Promise<string | undefined> {
    if (task.kind !== 'execute' || state.status !== 'working') return undefined;
    let p: Awaited<ReturnType<ChangeSetExecutor['progress']>>;
    try {
      p = await deps.executor.progress(task.changesetId);
    } catch (e) {
      // Progress is an extra; the status derived from the change-set still answers.
      if (e instanceof ExecutorUnavailable) return undefined;
      throw e;
    }
    return p === undefined ? undefined : `${String(p.done)} of ${String(p.total)} done, ${String(p.failed)} failed, ${String(p.skipped)} skipped`;
  }

  return {
    async get(params, ctx) {
      const task = await owned(params.taskId, ctx);
      const record = await deps.repository.get(task.changesetId);
      // The task row references the change-set, so this only happens if the row was purged.
      if (record === undefined) throw taskNotFound();
      const state = deriveTaskState(task.kind, record);
      const statusMessage = await statusMessageOf(task, state);
      const answer = state.status === 'completed' ? await answerOf(state, record) : undefined;
      return {
        resultType: 'complete',
        taskId: task.taskId,
        status: state.status,
        ...(statusMessage === undefined ? {} : { statusMessage }),
        createdAt: task.createdAt.toISOString(),
        lastUpdatedAt: (record.updatedAt ?? record.createdAt).toISOString(),
        ttlMs: task.ttlMs,
        pollIntervalMs: TASK_POLL_INTERVAL_MS,
        // The SDK stamps `resultType` on the top-level result only; the nested one is ours.
        ...(answer === undefined ? {} : { result: { ...toCallToolResult(answer), resultType: 'complete' as const } }),
      };
    },

    async update(params, ctx) {
      // No input requests are ever outstanding, so every response is ignored.
      await owned(params.taskId, ctx);
      return ACK;
    },

    async cancel(params, ctx) {
      const task = await owned(params.taskId, ctx);
      const { caller, correlationId } = ctx;
      // Cooperative (EXE-7): acknowledged whatever the outcome; a finished task keeps its status.
      let outcome: Awaited<ReturnType<ChangeSetExecutor['cancel']>> | { ok: false; reason: 'executor_unavailable' };
      try {
        outcome = await deps.executor.cancel({ changesetId: task.changesetId, actor: caller.subject, correlationId });
      } catch (e) {
        // Nothing was stored; the request is still acknowledged, and the audit row says why it did nothing.
        if (!(e instanceof ExecutorUnavailable)) throw e;
        outcome = { ok: false, reason: 'executor_unavailable' };
      }
      await deps.audit.append({
        id: deps.newId(),
        actor: caller.subject,
        ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
        action: 'task.cancel',
        outcome: outcome.ok ? 'ok' : 'error',
        correlationId,
        changesetId: task.changesetId,
        details: { taskId: task.taskId, ...(outcome.ok ? { status: outcome.status } : { reason: outcome.reason }) },
      });
      return ACK;
    },
  };
}
