// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { changesetTransitionEvent } from './audit.js';

const base = {
  id: 'e1',
  actor: 'alice',
  changeset: { id: 'cs1', operation: 'catalog.update_content' },
  from: 'prepared' as const,
  correlationId: 'corr',
};

describe('AUD-1 change-set transition event', () => {
  it('AUD-1 maps fields', () => {
    const e = changesetTransitionEvent({ ...base, to: 'executing', clientId: 'c', details: { items: 3 } });
    expect(e).toEqual({
      id: 'e1',
      actor: 'alice',
      clientId: 'c',
      action: 'changeset.transition',
      subject: 'catalog.update_content',
      outcome: 'ok',
      correlationId: 'corr',
      changesetId: 'cs1',
      details: { from: 'prepared', to: 'executing', operation: 'catalog.update_content', items: 3 },
    });
  });

  it('AUD-1 failed gives outcome error and null from is kept; no clientId key when absent', () => {
    const e = changesetTransitionEvent({ ...base, from: null, to: 'failed' });
    expect(e.outcome).toBe('error');
    expect(e.details).toMatchObject({ from: null });
    expect('clientId' in e).toBe(false);
  });
});
