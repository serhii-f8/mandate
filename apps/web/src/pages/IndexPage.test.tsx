// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexPage } from './IndexPage.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const session = (viewAudit: boolean) => ({ subject: 's', roles: [], csrfToken: 't', authTime: '2030-01-01T00:00:00.000Z', fresh: true, expiresAt: '2030-01-01T08:00:00.000Z', viewAudit });

describe('IndexPage', () => {
  it('UI-2 the home page links the audit page only for viewAudit', async () => {
    for (const viewAudit of [true, false]) {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(session(viewAudit)), { status: 200 }))));
      render(<IndexPage />);
      await waitFor(() => { expect(screen.getByRole('link', { name: 'Approvals' })).toBeTruthy(); });
      await waitFor(() => { expect(screen.queryByRole('link', { name: 'Audit' }) !== null).toBe(viewAudit); });
      cleanup();
    }
  });
});
