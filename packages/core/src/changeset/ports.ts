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

export interface ChangeWriter {
  writeBatch(input: {
    changeset: ChangeSetRecord;
    items: readonly ChangeItemRecord[];
  }): Promise<readonly ItemOutcome[]>;
}

export interface ExecutionProgress {
  readonly status: ChangeSetStatus;
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly skipped: number;
}

export type StartRefusal = 'not_found' | 'hash_mismatch' | 'expired' | 'not_executable';

/** Executor port (EXE-11). */
export interface ChangeSetExecutor {
  start(req: {
    changesetId: string;
    expectedHash: string;
    actor: string;
    correlationId: string;
  }): Promise<{ ok: true } | { ok: false; reason: StartRefusal }>;
  cancel(req: {
    changesetId: string;
    actor: string;
    correlationId: string;
  }): Promise<{ ok: true; status: ChangeSetStatus } | { ok: false; reason: 'not_found' | 'not_cancellable' }>;
  progress(changesetId: string): Promise<ExecutionProgress | undefined>;
}
