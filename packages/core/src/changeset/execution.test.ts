// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import {
  changesetBatchEvent,
  coverBatch,
  evaluateLimits,
  executionTerminal,
  failureThresholdExceeded,
  startEventFactory,
} from './execution.js';
import type { ChangeSetRecord, ChangeSetStats } from './model.js';

const NONE = { recordsSince: 0, executing: 0 };

describe('POL-4 evaluateLimits', () => {
  it('POL-4 names records_per_operation only above the limit', () => {
    expect(evaluateLimits({ role: 'r', recordsPerOperation: 2 }, 3, NONE)).toBe('records_per_operation');
    expect(evaluateLimits({ role: 'r', recordsPerOperation: 2 }, 2, NONE)).toBeUndefined();
  });
  it('POL-4 names records_per_day when usage plus records exceeds it', () => {
    expect(evaluateLimits({ role: 'r', recordsPerDay: 5 }, 2, { recordsSince: 4, executing: 0 })).toBe('records_per_day');
    expect(evaluateLimits({ role: 'r', recordsPerDay: 5 }, 1, { recordsSince: 4, executing: 0 })).toBeUndefined();
  });
  it('POL-4 names concurrent_executions when the cap is reached', () => {
    expect(evaluateLimits({ role: 'r', concurrentExecutions: 1 }, 1, { recordsSince: 0, executing: 1 })).toBe(
      'concurrent_executions',
    );
    expect(evaluateLimits({ role: 'r', concurrentExecutions: 2 }, 1, { recordsSince: 0, executing: 1 })).toBeUndefined();
  });
  it('POL-4 reports operation, then day, then concurrent', () => {
    const all = { role: 'r', recordsPerOperation: 1, recordsPerDay: 1, concurrentExecutions: 1 };
    const busy = { recordsSince: 5, executing: 3 };
    expect(evaluateLimits(all, 3, busy)).toBe('records_per_operation');
    expect(evaluateLimits({ ...all, recordsPerOperation: 9 }, 3, busy)).toBe('records_per_day');
    expect(evaluateLimits({ role: 'r', concurrentExecutions: 1 }, 3, busy)).toBe('concurrent_executions');
  });
  it('POL-4 has no limit without configuration', () => {
    expect(evaluateLimits({ role: 'r' }, 1000, { recordsSince: 1000, executing: 1000 })).toBeUndefined();
  });
});

describe('EXE-5 failureThresholdExceeded', () => {
  it('EXE-5 compares the failed share of processed items', () => {
    expect(failureThresholdExceeded({ written: 1, failed: 1, skipped: 0 }, 0.5)).toBe(false);
    expect(failureThresholdExceeded({ written: 0, failed: 2, skipped: 0 }, 0.5)).toBe(true);
    expect(failureThresholdExceeded({ written: 0, failed: 0, skipped: 0 }, 0.5)).toBe(false);
    expect(failureThresholdExceeded({ written: 0, failed: 1, skipped: 0 }, 1)).toBe(false);
  });
});

describe('EXE-3 coverBatch', () => {
  it('EXE-3 keeps the first outcome per target, drops strangers, fails gaps in item order', () => {
    const out = coverBatch(
      [{ targetId: 'a' }, { targetId: 'b' }, { targetId: 'c' }],
      [
        { targetId: 'c', status: 'skipped' },
        { targetId: 'x', status: 'written' },
        { targetId: 'a', status: 'written' },
        { targetId: 'a', status: 'failed', error: 'late' },
      ],
    );
    expect(out).toEqual([
      { targetId: 'a', status: 'written' },
      { targetId: 'b', status: 'failed', error: 'no_outcome' },
      { targetId: 'c', status: 'skipped' },
    ]);
  });
});

const stats = (written: number, failed: number, skipped = 0): ChangeSetStats => ({
  total: written + failed + skipped,
  included: written + failed + skipped,
  excluded: {},
  written,
  failed,
  skipped,
});

describe('EXE-6 executionTerminal', () => {
  it('EXE-6 maps done by failure counts', () => {
    expect(executionTerminal(stats(2, 0), 'done')).toEqual({ status: 'completed' });
    expect(executionTerminal(stats(1, 1), 'done')).toEqual({ status: 'completed_with_errors' });
    expect(executionTerminal(stats(0, 2), 'done')).toEqual({ status: 'failed' });
  });
  it('EXE-6 maps every other outcome to failed with its code', () => {
    for (const o of ['failure_threshold', 'writer_error', 'hash_mismatch', 'policy_denied', 'executor_error', 'approval_missing'] as const) {
      expect(executionTerminal(stats(1, 1), o)).toEqual({ status: 'failed', errorCode: o });
    }
  });
});

const cs: ChangeSetRecord = {
  id: 'cs1',
  operation: 'op.write',
  connection: 'c',
  requester: 'u',
  args: {},
  status: 'prepared',
  stats: stats(1, 0),
  configHash: 'h',
  correlationId: 'corr0',
  createdAt: new Date(0),
  expiresAt: new Date(1),
  approvalRound: 0,
};

describe('AUD-1 execution audit events', () => {
  const make = startEventFactory({
    newId: () => 'e1',
    actor: 'alice',
    clientId: 'cl',
    groups: ['g'],
    correlationId: 'corr1',
  });
  it('AUD-1 audits expiry as a system transition', () => {
    const e = make({ kind: 'expired', from: 'prepared' }, cs);
    expect(e).toMatchObject({ action: 'changeset.transition', actor: 'system', changesetId: 'cs1' });
    expect(e.details).toMatchObject({ from: 'prepared', to: 'expired' });
  });
  it('AUD-1 audits the start under the caller and correlation id', () => {
    const e = make({ kind: 'executing', from: 'approved' }, cs);
    expect(e).toMatchObject({ actor: 'alice', correlationId: 'corr1', action: 'changeset.transition' });
    expect(e.details).toMatchObject({ from: 'approved', to: 'executing' });
  });
  it('AUD-1 audits a limit denial as a policy decision without arguments', () => {
    const e = make({ kind: 'limit_denied', limit: 'records_per_day', role: 'editor' }, cs);
    expect(e).toMatchObject({
      action: 'policy.decision',
      decision: 'deny',
      outcome: 'denied',
      changesetId: 'cs1',
      actor: 'alice',
    });
    expect(e.details.rule).toBe('role:editor/limit:records_per_day');
    expect(e.details.reason).toBe('limit_exceeded');
    expect(JSON.stringify(e.details)).not.toContain('args');
  });
  it('POL-6 AUD-1 a limit denial is audited for the requester, transitions for the actor', () => {
    const asApprover = startEventFactory({
      newId: () => 'e2',
      actor: 'dave',
      groups: ['content-leads'],
      correlationId: 'corr2',
      requester: { subject: 'alice', groups: ['content'], clientId: 'cl-alice' },
    });
    const denied = asApprover({ kind: 'limit_denied', limit: 'records_per_day', role: 'editor' }, cs);
    expect(denied).toMatchObject({ action: 'policy.decision', actor: 'alice', clientId: 'cl-alice' });
    const started = asApprover({ kind: 'executing', from: 'approved' }, cs);
    expect(started).toMatchObject({ action: 'changeset.transition', actor: 'dave' });
  });
  it('AUD-1 audits a batch with counts only', () => {
    const e = changesetBatchEvent({
      id: 'b1',
      changeset: cs,
      batchNo: 3,
      counts: { written: 4, failed: 1, skipped: 0 },
      correlationId: 'corr1',
    });
    expect(e).toMatchObject({ action: 'changeset.batch', actor: 'system', changesetId: 'cs1' });
    expect(e.details).toEqual({ batchNo: 3, written: 4, failed: 1, skipped: 0, operation: 'op.write' });
  });
});
