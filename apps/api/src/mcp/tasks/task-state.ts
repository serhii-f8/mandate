// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/** Task status derived from the change-set on every read (MCP-7, design §4). */
import type { ChangeSetRecord, TaskKind } from '@mandate/core';

export interface TaskState {
  readonly status: 'working' | 'completed' | 'cancelled';
  readonly answer?: 'prepared' | 'preparation_error' | 'expired' | 'execution';
}

export function deriveTaskState(kind: TaskKind, record: ChangeSetRecord): TaskState {
  if (kind === 'execute') {
    if (record.status === 'executing' || record.status === 'approved') return { status: 'working' };
    if (record.status === 'cancelled') return { status: 'cancelled' };
    return { status: 'completed', answer: 'execution' };
  }
  // Once preparation finished, later states (failed, cancelled, expired) do not change its answer.
  if (record.preparedAt !== undefined) return { status: 'completed', answer: 'prepared' };
  switch (record.status) {
    case 'preparing':
      return { status: 'working' };
    case 'cancelled':
      return { status: 'cancelled' };
    case 'expired':
      return { status: 'completed', answer: 'expired' };
    default:
      return { status: 'completed', answer: 'preparation_error' };
  }
}
