// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
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

describe('IndexPage files link', () => {
  it('UI-2 the home page links the files page unless GET /api/v1/files answered 403', async () => {
    for (const status of [200, 403]) {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          return Promise.resolve(new Response(JSON.stringify(url === '/api/v1/files' ? (status === 200 ? [] : { error: 'forbidden' }) : session(false)), { status: url === '/api/v1/files' ? status : 200 }));
        }),
      );
      render(<IndexPage />);
      await waitFor(() => { expect(screen.getByRole('link', { name: 'Approvals' })).toBeTruthy(); });
      await waitFor(() => { expect(screen.queryByRole('link', { name: 'Files' }) !== null).toBe(status === 200); });
      cleanup();
    }
  });
});
