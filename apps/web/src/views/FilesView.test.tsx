// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StagedFile } from '../api.js';
import { FilesView } from './FilesView.js';

afterEach(cleanup);

const FILE: StagedFile = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'report.csv',
  mediaType: 'text/csv',
  size: 12,
  sha256: `sha256:${'a'.repeat(64)}`,
  preview: 'text',
  createdAt: '2026-11-23T10:00:00.000Z',
  expiresAt: '2026-11-24T10:00:00.000Z',
};

describe('UI-2 CS-10 the staged files list', () => {
  it('CS-10 the expiry column says it applies only to a file no change-set uses', () => {
    render(<FilesView files={[FILE]} forbidden={false} onUpload={vi.fn()} />);
    expect(screen.getByRole('columnheader', { name: 'Expires if unused' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Expires' })).toBeNull();
  });
});
