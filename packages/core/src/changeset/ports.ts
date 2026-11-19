import type { ApprovalPlan, ApprovalRecord, NewNotification, Submission } from '../approval/model.js';
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
  RollbackRequest,
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
  /** CS-5: the source change-set of a derived one. */
  readonly derivedFrom?: string;
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
  /**
   * Change-sets awaiting approval (UI-7): status `pending_approval`, `awaitingRole` in `roles`, requester
   * not `excludeRequester`; newest `submission.at` first, then `id` descending. `after` is exclusive;
   * limit 1..500; an empty `roles` list gives `[]`.
   */
  pendingApprovals(q: {
    roles: readonly string[];
    excludeRequester: string;
    after?: { submittedAt: Date; id: string };
    limit: number;
  }): Promise<readonly ChangeSetRecord[]>;
  /**
   * At most `size` included items (status not `excluded`) ordered by `md5(seed || targetId)` then
   * `targetId` (APR-5); size 1..500; unknown and non-UUID IDs give `[]`.
   */
  sampleItems(changesetId: string, seed: string, size: number): Promise<readonly ChangeItemRecord[]>;
  /**
   * CS-5: over the source's items, `unknown` = distinct `exclude` targets that are not `pending` plus distinct
   * `include` targets that are not `excluded` with reason `requester` (a target named in both lists counts once,
   * as unknown); `includedAfter` = items whose status after the copy rules would not be `excluded`. Unknown or
   * non-UUID source → { unknown: |exclude ∪ include|, includedAfter: 0 }.
   */
  deriveCheck(
    sourceId: string,
    exclude: readonly string[],
    include: readonly string[],
  ): Promise<{ unknown: number; includedAfter: number }>;
  /**
   * CS-5, NFR-7: one transaction. Locks `newId` FOR UPDATE; rejects ('change-set is not preparing') unless it is
   * `preparing`, rejects ('change-set already has items') when it has items; then one INSERT … SELECT copying every
   * item of `sourceId` with the copy rules: a `pending` target in `exclude` becomes `excluded` with reason
   * `requester`; a target in `include` (and not in `exclude`) excluded with reason `requester` becomes `pending`
   * without a reason; every other item keeps status and reason. `before`, `after` and `target_id` are copied and
   * `error` stays empty. Returns the number of rows copied.
   */
  copyItems(newId: string, sourceId: string, exclude: readonly string[], include: readonly string[]): Promise<number>;
  /** Compare-and-set from preparing. */
  completePreparation(
    changesetId: string,
    outcome:
      | { status: 'prepared'; hash: string; stats: ChangeSetStats; preparedAt: Date }
      /** `upstreamStatus`: the HTTP status of the failed read, when there was one (a number, never upstream text). */
      | { status: 'failed'; errorCode: string; upstreamStatus?: number },
    audit: AuditEventInput,
  ): Promise<ChangeSetRecord | undefined>;
  /**
   * Undefined when status is not in `from` (or the change-set is not expired before `expiredBefore`,
   * or `unlessBatches` is set and a batch of it exists). `unlessBatches` is checked under the same
   * lock `claimBatch` takes, so no batch is claimed between the check and the change (EXE-11).
   */
  transition(
    changesetId: string,
    from: readonly ChangeSetStatus[],
    to: ChangeSetStatus,
    audit: AuditEventInput,
    extra?: {
      errorCode?: string;
      expiredBefore?: Date;
      unlessBatches?: boolean;
      notifications?: readonly NewNotification[];
    },
  ): Promise<ChangeSetRecord | undefined>;
  /**
   * One transaction (APR-1): `prepared` to `pending_approval` with round + 1, the submission, the plan
   * and `awaitingRole = plan.steps[0]`, the two audit events and the outbox rows. Refuses `not_found`,
   * `expired` (CAS to `expired`, judged at `submission.at`), `hash_mismatch` and `not_prepared`.
   */
  submitForApproval(req: {
    changesetId: string;
    expectedHash: string;
    submission: Submission;
    plan: ApprovalPlan;
    audit: { transition: AuditEventInput; requested: AuditEventInput };
    notifications: readonly NewNotification[];
  }): Promise<
    { ok: true; changeset: ChangeSetRecord } | { ok: false; reason: 'not_found' | 'hash_mismatch' | 'not_prepared' | 'expired' }
  >;
  /** Approval rows ordered by round, then step; all rounds unless `round` is given. */
  approvals(changesetId: string, round?: number): Promise<readonly ApprovalRecord[]>;
  /**
   * One transaction (APR-3, APR-4): only while `pending_approval` in `round` with `step` the next
   * undecided step (`not_pending` otherwise, nothing stored). Stores the record, applies `next`
   * (a return goes to `prepared` and keeps the round), appends `audit` and the outbox rows.
   */
  recordDecision(req: {
    changesetId: string;
    round: number;
    step: number;
    record: ApprovalRecord;
    next: { kind: 'rejected' | 'returned' | 'approved' } | { kind: 'next_step'; awaitingRole: string };
    audit: readonly AuditEventInput[];
    notifications: readonly NewNotification[];
  }): Promise<{ ok: true; changeset: ChangeSetRecord } | { ok: false; reason: 'not_pending' }>;
  /** Number of items per non-null error code (CS-7: the drift number of the execution summary). */
  errorCounts(changesetId: string): Promise<Readonly<Record<string, number>>>;
  /** Only items with status pending; stats recomputed. */
  recordItemOutcomes(changesetId: string, outcomes: readonly ItemOutcome[]): Promise<void>;
  /**
   * One transaction (EXE-11, POL-4, POL-6): not found, expiry (CAS to `expired`, event `expired`),
   * no hash, hash mismatch, status not `prepared|approved`; from `approved` the current round's
   * approvals must cover every plan step for `expectedHash` (SEC-9, `not_approved`); then the limits under a per-requester
   * lock (refusal appends `limit_denied` and leaves the status); then CAS to `executing` with the
   * event `executing`, the execution request and `startedAt = now`.
   */
  startExecution(req: {
    changesetId: string;
    expectedHash: string;
    request: Omit<ExecutionRequest, 'startedAt'>;
    limits?: ExecutionLimits;
    /** Stored when starting from `prepared` without approval (POL-6). */
    submission?: Submission;
    notifications?: readonly NewNotification[];
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
   * answers its stored counts; an equal or higher stored attempt answers `fenced`, and so does a new
   * claim or a takeover while the change-set is not `executing`.
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
   * One transaction for the owning attempt of an open batch (EXE-3, AUD-1): item outcomes (first per
   * target, only for the batch's targets that are still pending; rejected unless executing), batch
   * `done` with counts of exactly those applied outcomes, and `audit`. Fenced answers `{ ok: false }`
   * and writes nothing.
   */
  completeBatch(
    changesetId: string,
    batchNo: number,
    attempt: number,
    outcomes: readonly ItemOutcome[],
    audit: AuditEventInput,
  ): Promise<{ ok: true; counts: BatchCounts } | { ok: false }>;
  /** EXE-8: items with status `written`, no error and no rollback status; 0 for an unknown or non-UUID ID. */
  rollbackableCount(changesetId: string): Promise<number>;
  /** EXE-8: sets `rollback_until = until` only while it is NULL (write-once) and answers the stored value; undefined for an unknown or non-UUID ID. */
  openRollbackWindow(changesetId: string, until: Date): Promise<Date | undefined>;
  /**
   * EXE-8, SEC-8: one transaction. Locks the change-set FOR UPDATE and reads the database clock; refuses
   * `not_found`; `already_rolled_back` (status rolling_back/rolled_back, or a request stored); `not_finished`
   * (status not in ROLLBACK_FROM, or cancelled/failed without execution); `window_closed` (rollback_until NULL or
   * `now() >= rollback_until − marginMs`). Then sets status `rolling_back` with the four request columns and
   * `updated_at`, appends `audit` in order, and answers the record. A refusal writes nothing.
   */
  requestRollback(req: {
    readonly changesetId: string;
    readonly request: RollbackRequest;
    readonly marginMs: number;
    readonly audit: readonly AuditEventInput[];
  }): Promise<
    | { ok: true; changeset: ChangeSetRecord }
    | { ok: false; reason: 'not_found' | 'already_rolled_back' | 'not_finished' | 'window_closed' }
  >;
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
  /**
   * Whose request the execution is when `actor` is the approver who starts it (POL-6): stored as the
   * execution request, and the identity limits are charged to and audited for.
   */
  requester?: { subject: string; groups: readonly string[]; clientId?: string };
  /** Stored when starting from `prepared` without approval (POL-6). */
  submission?: Submission;
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
  | 'executor_error'
  | 'approval_missing';

export interface ExecutionGuard {
  check(
    changeset: ChangeSetRecord,
  ): Promise<{ ok: true } | { ok: false; outcome: 'hash_mismatch' | 'policy_denied' | 'approval_missing' }>;
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

export type StartRefusal = 'not_found' | 'hash_mismatch' | 'expired' | 'not_executable' | 'limit_exceeded' | 'not_approved';

/** Executor port (EXE-11). `cancel` may answer `{ ok: true, status: 'executing' }` while a run winds down. */
export interface ChangeSetExecutor {
  start(req: StartRequest): Promise<StartOutcome>;
  cancel(req: {
    changesetId: string;
    actor: string;
    correlationId: string;
  }): Promise<{ ok: true; status: ChangeSetStatus } | { ok: false; reason: 'not_found' | 'not_cancellable' }>;
  progress(changesetId: string): Promise<ExecutionProgress | undefined>;
  /** Nudges the change-set's run to re-read its status (an approval, a cancel). Best effort; resolves for an unknown change-set. */
  wake(changesetId: string): Promise<void>;
}
