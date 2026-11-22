// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditPage } from './AuditPage.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const session = (viewAudit: boolean) => ({ subject: 's', roles: [], csrfToken: 't', authTime: '2030-01-01T00:00:00.000Z', fresh: true, expiresAt: '2030-01-01T08:00:00.000Z', viewAudit });
const ev = (seq: string, actor: string) => ({ seq, ts: '2030-01-01T00:00:00.000000Z', actor, action: 'tool.call', outcome: 'ok', subject: null, changesetId: null, correlationId: 'c', chainPos: null, details: {} });

function stub(handler: (url: string) => { status: number; body: unknown }) {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const a = handler(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return Promise.resolve(new Response(JSON.stringify(a.body), { status: a.status }));
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('AuditPage', () => {
  it('UI-2 SEC-1 without viewAudit the page requests no audit data', async () => {
    const mock = stub((url) => (url === '/api/v1/session' ? { status: 200, body: session(false) } : { status: 500, body: {} }));
    render(<AuditPage />);
    await screen.findByText('You are not allowed to view the audit log.');
    expect(mock.mock.calls.map((c) => (c[0] as string))).toEqual(['/api/v1/session']);
  });

  it('UI-2 appends the next page on More', async () => {
    stub((url) => {
      if (url === '/api/v1/session') return { status: 200, body: session(true) };
      if (url === '/api/v1/audit') return { status: 200, body: { events: [ev('2', 'first-actor')], nextCursor: 'k' } };
      if (url === '/api/v1/audit?cursor=k') return { status: 200, body: { events: [ev('1', 'second-actor')] } };
      return { status: 500, body: {} };
    });
    render(<AuditPage />);
    await screen.findByText('first-actor');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    await screen.findByText('second-actor');
    expect(screen.getByText('first-actor')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('UI-2 a 400 shows the filter hint', async () => {
    stub((url) => (url === '/api/v1/session' ? { status: 200, body: session(true) } : { status: 400, body: {} }));
    render(<AuditPage />);
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('Check the filter values.'); });
  });
});
