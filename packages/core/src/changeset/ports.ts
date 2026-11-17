import type { AuditEventInput } from '../audit.js';
import type { ChangeItemRecord, ChangeSetRecord, ChangeSetStats, ChangeSetStatus, ItemStatus } from './model.js';

export type PrepareFailure = 'targets_missing' | 'too_many_targets' | 'incomplete_read' | 'cancelled' | (string & {});

export interface NewChangeSet {
  readonly id: string;
  readonly operation: string;
  readonly connection: string;
  readonly requester: string;
  readonly clientId?: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly configHash: string;
  readonly correlationId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface ItemsPageQuery {
  readonly after?: string;
  readonly limit: number;
  readonly status?: ItemStatus;
}

export interface ItemOutcome {
  readonly targetId: string;
  readonly status: 'written' | 'failed' | 'skipped';
  readonly error?: string;
}

export interface ChangeSetRepository {
  create(cs: NewChangeSet, audit: AuditEventInput): Promise<ChangeSetRecord>;
  /** Rejects unless status is preparing; duplicates by targetId are ignored. Returns the number inserted. */
  appendItems(changesetId: string, items: readonly ChangeItemRecord[]): Promise<number>;
  stats(changesetId: string): Promise<ChangeSetStats>;
  get(changesetId: string): Promise<ChangeSetRecord | undefined>;
  /** Ordered by compareTargetIds, limit 1..500. */
  itemsPage(changesetId: string, query: ItemsPageQuery): Promise<readonly ChangeItemRecord[]>;
  /** Compare-and-set from preparing. */
  completePreparation(
    changesetId: string,
    outcome:
      | { status: 'prepared'; hash: string; stats: ChangeSetStats; preparedAt: Date }
      | { status: 'failed'; errorCode: string },
    audit: AuditEventInput,
  ): Promise<ChangeSetRecord | undefined>;
  /** Undefined when status is not in `from` (or the change-set is not expired before `expiredBefore`). */
  transition(
    changesetId: string,
    from: readonly ChangeSetStatus[],
    to: ChangeSetStatus,
    audit: AuditEventInput,
    extra?: { errorCode?: string; expiredBefore?: Date },
  ): Promise<ChangeSetRecord | undefined>;
  /** Only items with status pending; stats recomputed. */
  recordItemOutcomes(changesetId: string, outcomes: readonly ItemOutcome[]): Promise<void>;
}

/** The repository operations preparation uses; later port growth does not touch its fakes. */
export type PreparationRepository = Pick<
  ChangeSetRepository,
  'create' | 'appendItems' | 'stats' | 'get' | 'itemsPage' | 'completePreparation'
>;

export type ReadPage =
  | {
      readonly ok: true;
      readonly items: readonly Record<string, unknown>[];
      readonly total?: number;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly code: string; readonly status?: number };

export interface UpstreamReader {
  read(operationId: string, args: Readonly<Record<string, unknown>>): Promise<ReadPage>;
}

export type PlanEntry =
  | { readonly targetId: string; readonly action: 'write' }
  | {
      readonly targetId: string;
      readonly action: 'outcome';
      readonly status: 'written' | 'skipped' | 'failed';
      readonly error: string;
    };

export interface BatchSubmission {
  readonly upstreamBatchId: string;
  readonly plan: readonly PlanEntry[];
}

export interface BatchContext {
  readonly key: string;
  readonly submission?: BatchSubmission;
  recordSubmission(s: BatchSubmission): Promise<void>;
  heartbeat(): void;
}

/** Thrown when a newer attempt of the batch has taken over (EXE-4). */
export class BatchFenced extends Error {
  constructor() {
    super('batch attempt superseded');
    this.name = 'BatchFenced';
  }
}

export interface ChangeWriter {
  writeBatch(input: {
    changeset: ChangeSetRecord;
    items: readonly ChangeItemRecord[];
    batch: BatchContext;
  }): Promise<readonly ItemOutcome[]>;
}

export type LimitName = 'records_per_operation' | 'records_per_day' | 'concurrent_executions';

export interface ExecutionLimits {
  readonly role: string;
  readonly recordsPerOperation?: number;
  readonly recordsPerDay?: number;
  readonly concurrentExecutions?: number;
}

export type StartOutcome =
  | { ok: true }
  | { ok: false; reason: Exclude<StartRefusal, 'limit_exceeded'> }
  | { ok: false; reason: 'limit_exceeded'; limit: LimitName };

export interface StartRequest {
  changesetId: string;
  expectedHash: string;
  actor: string;
  correlationId: string;
  groups?: readonly string[];
  limits?: ExecutionLimits;
  clientId?: string;
}

export interface WorkflowStarter {
  start(changesetId: string): Promise<void>;
}

export interface RateCounter {
  hit(key: string, windowStart: Date): Promise<number>;
}

/** Usage of a role's callers, excluding the change-set being started. */
export interface ExecutionUsage {
  readonly recordsSince: number;
  readonly executing: number;
}

export type FinishOutcome =
  | 'done'
  | 'cancelled'
  | 'failure_threshold'
  | 'writer_error'
  | 'hash_mismatch'
  | 'policy_denied'
  | 'executor_error';

export interface ExecutionGuard {
  check(
    changeset: ChangeSetRecord,
  ): Promise<{ ok: true } | { ok: false; outcome: 'hash_mismatch' | 'policy_denied' }>;
}

export class ExecutorUnavailable extends Error {
  constructor() {
    super('executor_unavailable');
    this.name = 'ExecutorUnavailable';
  }
}

export type StartEvent =
  | { kind: 'expired' | 'executing'; from: ChangeSetStatus }
  | { kind: 'limit_denied'; limit: LimitName; role: string };

export interface ExecutionProgress {
  readonly status: ChangeSetStatus;
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly skipped: number;
}

/** Alias of the progress shape for the workflow query result. */
export type WorkflowProgress = ExecutionProgress;

export type StartRefusal = 'not_found' | 'hash_mismatch' | 'expired' | 'not_executable' | 'limit_exceeded';

/** Executor port (EXE-11). `cancel` may answer `{ ok: true, status: 'executing' }` while a run winds down. */
export interface ChangeSetExecutor {
  start(req: StartRequest): Promise<StartOutcome>;
  cancel(req: {
    changesetId: string;
    actor: string;
    correlationId: string;
  }): Promise<{ ok: true; status: ChangeSetStatus } | { ok: false; reason: 'not_found' | 'not_cancellable' }>;
  progress(changesetId: string): Promise<ExecutionProgress | undefined>;
}
