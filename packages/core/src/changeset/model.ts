export type ChangeSetStatus =
  | 'preparing'
  | 'prepared'
  | 'pending_approval'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'rolling_back'
  | 'rolled_back';

export type ItemStatus = 'pending' | 'excluded' | 'written' | 'failed' | 'skipped';

export type ExclusionReason = 'not_found' | 'out_of_scope' | 'missing_data' | 'no_change';

export interface ChangeSetStats {
  readonly total: number;
  readonly included: number;
  readonly excluded: Readonly<Partial<Record<ExclusionReason, number>>>;
  readonly written: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface ExecutionRequest {
  readonly actor: string;
  readonly groups: readonly string[];
  readonly clientId?: string;
  readonly correlationId: string;
  readonly startedAt: Date;
}

export interface CancelRequest {
  readonly actor: string;
  readonly correlationId: string;
  readonly requestedAt: Date;
}

export interface ChangeSetRecord {
  readonly id: string;
  readonly operation: string;
  readonly connection: string;
  readonly requester: string;
  readonly clientId?: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly hash?: string;
  readonly status: ChangeSetStatus;
  readonly stats: ChangeSetStats;
  readonly errorCode?: string;
  readonly configHash: string;
  readonly correlationId: string;
  readonly createdAt: Date;
  /** Latest transition or outcome time (MCP-7 task `lastUpdatedAt`). */
  readonly updatedAt?: Date;
  readonly preparedAt?: Date;
  readonly expiresAt: Date;
  readonly executionRequest?: ExecutionRequest;
  readonly cancelRequest?: CancelRequest;
}

export interface ChangeItemRecord {
  readonly targetId: string;
  readonly status: ItemStatus;
  readonly reason?: ExclusionReason;
  readonly before: unknown;
  readonly after: unknown;
  readonly error?: string;
}

export const EMPTY_STATS: ChangeSetStats = Object.freeze({
  total: 0,
  included: 0,
  excluded: Object.freeze({}),
  written: 0,
  failed: 0,
  skipped: 0,
});
