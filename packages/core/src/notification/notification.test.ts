// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import {
  afterFailure,
  notificationAuditEvent,
  retryDelayMs,
  type NotificationRow,
} from './outbox.js';
import { approvalRequestNotifications, resultNotifications, type RoleNotifyTargets } from './targets.js';

describe('NTF-3 retry schedule', () => {
  it('NTF-3 doubles from 30 s and caps at one hour', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(retryDelayMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000,
    ]);
    expect(retryDelayMs(20)).toBe(3_600_000);
  });

  it('NTF-3 retries until attempt 8 has failed, then gives up', () => {
    expect(afterFailure(7)).toEqual({ kind: 'retry', delayMs: 1_920_000 });
    expect(afterFailure(8)).toEqual({ kind: 'failed' });
    expect(afterFailure(9)).toEqual({ kind: 'failed' });
  });
});

const row: NotificationRow = {
  id: 'n1',
  kind: 'approval_requested',
  changesetId: 'cs1',
  round: 1,
  step: 1,
  target: 'chat',
  state: 'pending',
  attempts: 3,
  nextAttemptAt: new Date(0),
  createdAt: new Date(0),
};

describe('AUD-1 notification audit event', () => {
  it('AUD-1 a failure records the closed error code and nothing else', () => {
    const e = notificationAuditEvent({ id: 'a1', row, outcome: 'failed', error: 'http_status', correlationId: 'c1' });
    expect(e).toMatchObject({
      id: 'a1',
      action: 'notification.failed',
      actor: 'system',
      subject: 'chat',
      outcome: 'error',
      changesetId: 'cs1',
      correlationId: 'c1',
    });
    expect(e.details).toEqual({ kind: 'approval_requested', target: 'chat', attempts: 3, error: 'http_status' });
  });

  it('AUD-1 a success has no error key', () => {
    const e = notificationAuditEvent({ id: 'a2', row, outcome: 'sent', correlationId: 'c1' });
    expect(e.action).toBe('notification.sent');
    expect(e.outcome).toBe('ok');
    expect(Object.keys(e.details)).toEqual(['kind', 'target', 'attempts']);
  });
});

describe('NTF-1 targets', () => {
  const notify: RoleNotifyTargets = new Map([
    ['content_lead', { approvalRequests: ['mail', 'mail', 'chat'], results: [] }],
    ['content_manager', { approvalRequests: ['x'], results: ['chat'] }],
  ]);

  it('NTF-1 approval requests dedupe targets in order', () => {
    expect(approvalRequestNotifications(notify, { role: 'content_lead', round: 2, step: 1 })).toEqual([
      { kind: 'approval_requested', round: 2, step: 1, target: 'mail' },
      { kind: 'approval_requested', round: 2, step: 1, target: 'chat' },
    ]);
  });

  it('NTF-1 an unknown role has no targets', () => {
    expect(approvalRequestNotifications(notify, { role: 'nobody', round: 1, step: 1 })).toEqual([]);
  });

  it('NTF-1 results go to the requester role targets', () => {
    expect(
      resultNotifications(notify, { kind: 'execution_finished', role: 'content_manager', round: 1, step: 0 }),
    ).toEqual([{ kind: 'execution_finished', round: 1, step: 0, target: 'chat' }]);
  });

  it('NTF-1 a missing role gives no result notifications', () => {
    expect(
      resultNotifications(notify, { kind: 'approval_decided', role: undefined, round: 1, step: 1 }),
    ).toEqual([]);
  });
});
