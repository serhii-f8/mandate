// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueueEntry } from '../api.js';
import { ApprovalsView } from './ApprovalsView.js';

afterEach(cleanup);

const ID = '11111111-1111-4111-8111-111111111111';
const entry: QueueEntry = { id: ID, operation: 'catalog.update', title: 'Update brands', requester: 'ann', total: 4, step: 1, steps: 2, expiresAt: '2030-01-01T00:00:00.000Z' };

describe('ApprovalsView', () => {
  it('UI-2 APR-7 the queue links each change-set by id only', () => {
    render(<ApprovalsView queue={{ items: [entry] }} />);
    expect(screen.getByRole('link', { name: /update brands/i }).getAttribute('href')).toBe(`/app/changesets/${ID}`);
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
  });

  it('UI-2 an empty queue says so', () => {
    render(<ApprovalsView queue={{ items: [] }} />);
    expect(screen.getByText('Nothing awaits your decision.')).toBeTruthy();
  });
});
