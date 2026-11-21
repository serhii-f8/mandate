// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/** The answer of a tool call that may create a task (MCP-7). */
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { TaskRecord } from '@aiops/core';

export const TASK_POLL_INTERVAL_MS = 2000;

export interface CreateTaskResult {
  resultType: 'task';
  taskId: string;
  status: 'working';
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
}

export type ToolAnswer = CallToolResult | CreateTaskResult;

export function isTaskAnswer(a: ToolAnswer): a is CreateTaskResult {
  return 'resultType' in a && a.resultType === 'task';
}

export function createTaskResult(task: TaskRecord): CreateTaskResult {
  const createdAt = task.createdAt.toISOString();
  return {
    resultType: 'task',
    taskId: task.taskId,
    status: 'working',
    createdAt,
    lastUpdatedAt: createdAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: TASK_POLL_INTERVAL_MS,
  };
}
