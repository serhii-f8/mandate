// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { TASK_TTL_MS } from '@mandate/core';
import { createTaskResult, isTaskAnswer, TASK_POLL_INTERVAL_MS } from './task-result.js';

describe('MCP-7 createTaskResult', () => {
  it('uses ISO timestamps with lastUpdatedAt equal to createdAt', () => {
    const result = createTaskResult({
      taskId: 't',
      owner: 'o',
      changesetId: 'c',
      kind: 'prepare',
      tool: 'x',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      ttlMs: TASK_TTL_MS,
    });
    expect(result).toEqual({
      resultType: 'task',
      taskId: 't',
      status: 'working',
      createdAt: '2026-01-02T03:04:05.000Z',
      lastUpdatedAt: '2026-01-02T03:04:05.000Z',
      ttlMs: TASK_TTL_MS,
      pollIntervalMs: TASK_POLL_INTERVAL_MS,
    });
    expect(isTaskAnswer(result)).toBe(true);
    expect(isTaskAnswer({ content: [] })).toBe(false);
  });
});
