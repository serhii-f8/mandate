// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from './audit.js';

describe('AUD-1 audit actions', () => {
  it('AUD-1 AUDIT_ACTIONS lists the audit actions once each', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    expect(AUDIT_ACTIONS).toEqual(expect.arrayContaining(['audit.search', 'audit.export', 'audit.retention', 'changeset.rollback', 'config.apply', 'config.load', 'rate.limited']));
  });
});
