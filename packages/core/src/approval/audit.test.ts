// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { approvalDecisionEvent, approvalRequestedEvent } from './audit.js';

const changeset = { id: 'cs1', operation: 'op.write' };

describe('AUD-1 approval audit events', () => {
  it('AUD-1 SEC-3 approval.decision carries counts and reason, never a comment', () => {
    const comment = 'secret-comment-text';
    const event = approvalDecisionEvent({
      id: 'e1',
      actor: 'bob',
      clientId: 'client',
      changeset,
      round: 1,
      step: 2,
      role: 'lead',
      channel: 'page',
      decision: 'return',
      count: 3,
      correlationId: 'corr',
      // A caller that mistakenly passes the comment must still not leak it.
      ...({ comment } as object),
    });
    expect(JSON.stringify(event)).not.toContain(comment);
    expect(event).toMatchObject({
      action: 'approval.decision',
      outcome: 'ok',
      changesetId: 'cs1',
      clientId: 'client',
      details: { round: 1, step: 2, role: 'lead', decision: 'return', channel: 'page', count: 3 },
    });
  });

  it('AUD-1 SEC-11 a refusal is denied with details.reason', () => {
    const event = approvalDecisionEvent({
      id: 'e2',
      actor: 'bob',
      changeset,
      round: 1,
      channel: 'widget',
      decision: 'approve',
      count: 3,
      refusal: 'widget_not_allowed',
      correlationId: 'corr',
    });
    expect(event.outcome).toBe('denied');
    expect(event.details).toMatchObject({ reason: 'widget_not_allowed' });
    expect(event.details).not.toHaveProperty('step');
  });

  it('AUD-1 approval.requested names round, step and role', () => {
    const event = approvalRequestedEvent({
      id: 'e3',
      actor: 'alice',
      changeset,
      round: 1,
      step: 1,
      role: 'lead',
      correlationId: 'corr',
    });
    expect(event).toMatchObject({
      action: 'approval.requested',
      outcome: 'ok',
      changesetId: 'cs1',
      details: { round: 1, step: 1, role: 'lead', operation: 'op.write' },
    });
  });
});
