// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { and, eq } from 'drizzle-orm';
import { isTaskId, type TaskRecord, type TaskRepository } from '@aiops/core';
import type { Db } from './client.js';
import { guarded } from './errors.js';
import { mcpTask } from './schema.js';

/** PostgreSQL task repository (MCP-7). Errors leave through `guarded`, so messages carry no values (SEC-3). */
export class PostgresTaskRepository implements TaskRepository {
  constructor(private readonly db: Db) {}

  async create(task: TaskRecord): Promise<void> {
    await guarded('task create', () =>
      this.db.insert(mcpTask).values({
        taskId: task.taskId,
        owner: task.owner,
        clientId: task.clientId ?? null,
        changesetId: task.changesetId,
        kind: task.kind,
        tool: task.tool,
        createdAt: task.createdAt,
        ttlMs: task.ttlMs,
      }),
    );
  }

  async findOwned(taskId: string, owner: string): Promise<TaskRecord | undefined> {
    if (!isTaskId(taskId)) return undefined;
    const [row] = await guarded('task read', () =>
      this.db
        .select()
        .from(mcpTask)
        .where(and(eq(mcpTask.taskId, taskId.toLowerCase()), eq(mcpTask.owner, owner))),
    );
    if (row === undefined) return undefined;
    return {
      taskId: row.taskId,
      owner: row.owner,
      ...(row.clientId === null ? {} : { clientId: row.clientId }),
      changesetId: row.changesetId,
      kind: row.kind,
      tool: row.tool,
      createdAt: row.createdAt,
      ttlMs: row.ttlMs,
    };
  }
}
