/** MCP Tasks (MCP-7): the task row only binds a task ID to its owner; state is derived from the change-set. */
export type TaskKind = 'prepare' | 'execute';

/** Retention advertised for every task: seven days. */
export const TASK_TTL_MS = 604_800_000;

export interface TaskRecord {
  readonly taskId: string;
  /** Subject of the caller that created the task (SEC-1). */
  readonly owner: string;
  readonly clientId?: string;
  readonly changesetId: string;
  readonly kind: TaskKind;
  readonly tool: string;
  readonly createdAt: Date;
  readonly ttlMs: number;
}

export interface TaskRepository {
  /** Rejects a duplicate task ID. */
  create(task: TaskRecord): Promise<void>;
  /** Undefined for unknown IDs, foreign owners and IDs that are not UUIDs (no store access for those). */
  findOwned(taskId: string, owner: string): Promise<TaskRecord | undefined>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a UUID in canonical 36-character form, lowercase or uppercase. */
export function isTaskId(value: string): boolean {
  return value.length === 36 && UUID.test(value);
}
