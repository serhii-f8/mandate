/**
 * A call of an allowed `write` or `destructive` operation with a manifest creates a change-set in `preparing` and
 * starts its workflow (EXE-1); the workflow prepares it (design §4.1, CS-1), and nothing is
 * written upstream. A request that declared Tasks gets a task once its row is committed (MCP-7);
 * any other request waits a bounded time for preparation and answers with the result, or with
 * "being prepared" (MCP-1). Answers carry counts and IDs only (MCP-4, SEC-5).
 */
import type { LoadedConfiguration } from '@aiops/config';
import {
  changesetTransitionEvent,
  createChangeSet,
  preparationErrorResult,
  TASK_TTL_MS,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type InvocationRequest,
  type InvocationResult,
  type OperationInvoker,
  type TaskRepository,
  type WorkflowStarter,
} from '@aiops/core';
import { deriveTaskState } from '../mcp/tasks/task-state.js';
import { riskNotSupportedResult } from '../upstream/risk-not-supported.js';
import { expiredDuringPreparationAnswer, preparationErrorAnswer, preparedAnswer, preparingAnswer } from './results.js';

/** How long a call without Tasks waits for preparation, and how often it looks. */
export interface PrepareWait {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface ChangeSetInvokerDeps {
  /** The request's configuration snapshot, the one its policy decision used (SEC-1). */
  readonly configuration: LoadedConfiguration;
  readonly repository: ChangeSetRepository;
  readonly tasks: TaskRepository;
  readonly starter: WorkflowStarter;
  readonly newId: () => string;
  readonly now: () => Date;
  readonly correlationId: string;
  readonly wait: PrepareWait;
}

type Details = Record<string, string | number | boolean>;

/** Throws on settings that would spin or never end; a zero timeout answers without waiting. */
export function checkPrepareWait(wait: Pick<PrepareWait, 'timeoutMs' | 'pollMs'>): void {
  if (!(Number.isFinite(wait.pollMs) && wait.pollMs > 0)) throw new Error('prepare wait: pollMs must be positive');
  if (!(Number.isFinite(wait.timeoutMs) && wait.timeoutMs >= 0)) throw new Error('prepare wait: timeoutMs must not be negative');
}

export class ChangeSetInvoker implements OperationInvoker {
  constructor(private readonly deps: ChangeSetInvokerDeps) {
    checkPrepareWait(deps.wait);
  }

  async invoke({ operation, args, caller, asTask, report }: InvocationRequest): Promise<InvocationResult> {
    const { manifest } = operation;
    if ((operation.risk !== 'write' && operation.risk !== 'destructive') || manifest === undefined) return riskNotSupportedResult(operation);
    const { configuration, repository, correlationId } = this.deps;
    const base: Details = { operation: operation.id, connection: operation.connection };

    const created = await createChangeSet(
      { repository, newId: this.deps.newId, now: this.deps.now },
      {
        operation: { ...operation, manifest },
        args,
        caller,
        correlationId,
        configHash: configuration.hash,
        expireAfterHours: configuration.changesets.expireAfterHours,
      },
    );
    if (!created.ok) {
      return { ...preparationErrorResult(operation.id, created.code), auditDetails: { ...base, errorCode: created.code } };
    }
    const { changeset } = created;
    const withId: Details = { ...base, changesetId: changeset.id };
    // On the tool.call row from here on, even if the start or the task write throws (AUD-1).
    report?.(withId);

    try {
      await this.deps.starter.start(changeset.id);
    } catch {
      // The start's error stays out of results and audit (SEC-3): only the fixed code.
      const marked = await repository.completePreparation(
        changeset.id,
        { status: 'failed', errorCode: 'executor_unavailable' },
        changesetTransitionEvent({
          id: this.deps.newId(),
          actor: 'system',
          changeset,
          from: 'preparing',
          to: 'failed',
          correlationId,
          details: { errorCode: 'executor_unavailable' },
        }),
      );
      // A lost compare-and-set means the workflow did start and moved the change-set on (for
      // example, the start timed out after the server accepted it): carry on as a started call.
      if (marked !== undefined) {
        return {
          ...preparationErrorResult(operation.id, 'executor_unavailable', changeset.id),
          auditDetails: { ...withId, errorCode: 'executor_unavailable' },
        };
      }
    }

    if (asTask === true) {
      const task = {
        taskId: this.deps.newId(),
        owner: caller.subject,
        ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
        changesetId: changeset.id,
        kind: 'prepare' as const,
        tool: operation.toolName,
        createdAt: this.deps.now(),
        ttlMs: TASK_TTL_MS,
      };
      // Committed before the handle is returned, so the first tasks/get finds it (MCP-7).
      await this.deps.tasks.create(task);
      return { text: '', task, auditDetails: withId };
    }

    const finished = await this.waitForPreparation(changeset.id);
    if (finished === undefined) return { ...preparingAnswer(changeset.id), auditDetails: withId };
    return this.answer(finished, withId);
  }

  /** The change-set once it left `preparing`, or undefined when the wait ran out (NFR-3: state is read, not held). */
  private async waitForPreparation(id: string): Promise<ChangeSetRecord | undefined> {
    const { timeoutMs, pollMs, sleep } = this.deps.wait;
    const settled = async (): Promise<ChangeSetRecord | undefined> => {
      const record = await this.deps.repository.get(id);
      return record === undefined || record.status === 'preparing' ? undefined : record;
    };
    let record = await settled();
    for (let i = 0; record === undefined && i < Math.ceil(timeoutMs / pollMs); i++) {
      await sleep(pollMs);
      record = await settled();
    }
    return record;
  }

  /** One state, one answer: the same derivation the Tasks handlers use. */
  private async answer(record: ChangeSetRecord, withId: Details): Promise<InvocationResult> {
    const state = deriveTaskState('prepare', record);
    if (state.status === 'completed' && state.answer === 'prepared') {
      const excluded = Object.values(record.stats.excluded).reduce((sum, n) => sum + n, 0);
      return { ...(await preparedAnswer(this.deps.repository, record)), auditDetails: { ...withId, included: record.stats.included, excluded } };
    }
    if (state.status === 'completed' && state.answer === 'expired') {
      return { ...expiredDuringPreparationAnswer(record), auditDetails: { ...withId, errorCode: 'expired' } };
    }
    const answer = preparationErrorAnswer(record);
    const code = record.status === 'cancelled' ? 'cancelled' : (record.errorCode ?? 'internal');
    // As in Phase 4: the upstream HTTP status of a failed read, a number only (SEC-3).
    const status = record.status === 'failed' ? record.errorStatus : undefined;
    return { ...answer, auditDetails: { ...withId, errorCode: code, ...(status === undefined ? {} : { upstreamStatus: status }) } };
  }
}
