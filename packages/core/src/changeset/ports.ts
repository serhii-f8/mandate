import type { AuditEventInput } from '../audit.js';
import type { BatchCounts } from './execution.js';
import type {
  CancelRequest,
  ChangeItemRecord,
  ChangeSetRecord,
  ChangeSetStats,
  ChangeSetStatus,
  ExecutionRequest,
  ItemStatus,
} from './model.js';

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
  /**
   * One transaction (EXE-11, POL-4, POL-6): not found, expiry (CAS to `expired`, event `expired`),
   * no hash, hash mismatch, status not `prepared|approved`; then the limits under a per-requester
   * lock (refusal appends `limit_denied` and leaves the status); then CAS to `executing` with the
   * event `executing`, the execution request and `startedAt = now`.
   */
  startExecution(req: {
    changesetId: string;
    expectedHash: string;
    request: Omit<ExecutionRequest, 'startedAt'>;
    limits?: ExecutionLimits;
    now: Date;
    event: (e: StartEvent, changeset: ChangeSetRecord) => AuditEventInput;
  }): Promise<{ ok: true; changeset: ChangeSetRecord } | Exclude<StartOutcome, { ok: true }>>;
  /**
   * Stores the cancel request only while executing and only the first one (EXE-7). `ok: true`
   * with the record (an earlier request kept) while executing; otherwise the current status
   * (undefined when not found).
   */
  requestCancel(
    changesetId: string,
    cancel: CancelRequest,
  ): Promise<{ ok: true; changeset: ChangeSetRecord } | { ok: false; status?: ChangeSetStatus }>;
  /** Included records of the requester's executions started at or after `since`, and its executing count (POL-4). */
  usage(requester: string, since: Date): Promise<ExecutionUsage>;
  /**
   * Claims batch `batchNo` for `attempt` (EXE-3, size 1..1000). A new batch takes the next `size`
   * pending items after the highest existing batch's last target; `empty` when none. A done batch
   * answers its stored counts; an equal or higher stored attempt answers `fenced`.
   */
  claimBatch(
    changesetId: string,
    batchNo: number,
    attempt: number,
    size: number,
  ): Promise<
    | { kind: 'claimed'; batch: BatchRecord; items: readonly ChangeItemRecord[] }
    | { kind: 'done'; counts: BatchCounts }
    | { kind: 'fenced' }
    | { kind: 'empty' }
  >;
  /** Stores the upstream batch ID and plan for the owning attempt of an open batch; false when fenced (NFR-2). */
  recordSubmission(changesetId: string, batchNo: number, attempt: number, submission: BatchSubmission): Promise<boolean>;
  /**
   * One transaction for the owning attempt of an open batch (EXE-3, AUD-1): item outcomes (pending
   * items only; rejected unless executing), batch `done` with counts from `outcomes` (first per
   * target), and `audit`. Fenced answers `{ ok: false }` and writes nothing.
   */
  completeBatch(
    changesetId: string,
    batchNo: number,
    attempt: number,
    outcomes: readonly ItemOutcome[],
    audit: AuditEventInput,
  ): Promise<{ ok: true; counts: BatchCounts } | { ok: false }>;
}

/** A claimed write batch (EXE-3). */
export interface BatchRecord {
  readonly changesetId: string;
  readonly batchNo: number;
  readonly attempt: number;
  readonly targetIds: readonly string[];
  readonly submission?: BatchSubmission;
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
