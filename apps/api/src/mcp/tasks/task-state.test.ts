import { describe, expect, it } from 'vitest';
import { EMPTY_STATS, type ChangeSetRecord, type ChangeSetStatus, type TaskKind } from '@aiops/core';
import { deriveTaskState } from './task-state.js';

function record(status: ChangeSetStatus, prepared: boolean): ChangeSetRecord {
  return {
    id: 'cs-1',
    operation: 'op',
    connection: 'c',
    requester: 'alice',
    args: {},
    status,
    stats: EMPTY_STATS,
    configHash: 'h',
    correlationId: 'corr',
    createdAt: new Date(0),
    expiresAt: new Date(1),
    ...(prepared ? { preparedAt: new Date(0) } : {}),
  };
}

type Row = [TaskKind, ChangeSetStatus, boolean, string, string | undefined];
const rows: Row[] = [
  ['prepare', 'preparing', false, 'working', undefined],
  ['prepare', 'prepared', true, 'completed', 'prepared'],
  ['prepare', 'executing', true, 'completed', 'prepared'],
  ['prepare', 'cancelled', true, 'completed', 'prepared'],
  ['prepare', 'failed', false, 'completed', 'preparation_error'],
  ['prepare', 'failed', true, 'completed', 'prepared'],
  ['prepare', 'cancelled', false, 'cancelled', undefined],
  ['prepare', 'expired', false, 'completed', 'expired'],
  ['execute', 'executing', true, 'working', undefined],
  ['execute', 'completed', true, 'completed', 'execution'],
  ['execute', 'completed_with_errors', true, 'completed', 'execution'],
  ['execute', 'failed', true, 'completed', 'execution'],
  ['execute', 'cancelled', true, 'cancelled', undefined],
  ['execute', 'approved', true, 'working', undefined],
  ['prepare', 'expired', true, 'completed', 'prepared'],
  ['prepare', 'rejected', false, 'completed', 'preparation_error'],
  ['execute', 'rolled_back', true, 'completed', 'execution'],
];

describe('MCP-7 task status derivation', () => {
  it.each(rows)('MCP-7 %s %s (prepared %s) → %s %s', (kind, status, prepared, expected, answer) => {
    const state = deriveTaskState(kind, record(status, prepared));
    expect(state.status).toBe(expected);
    expect(state.answer).toBe(answer);
  });
});
