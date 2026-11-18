import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeSetDetail, Session } from '../api.js';
import { ChangeSetPage } from './ChangeSetPage.js';

const ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const HASH = `sha256:${'a'.repeat(64)}`;
const RETURN_TO = encodeURIComponent(`/app/changesets/${ID}`);

const session: Session = {
  subject: 'dave',
  roles: ['content_lead'],
  csrfToken: 'tok',
  authTime: '2030-01-01T00:00:00.000Z',
  fresh: true,
  expiresAt: '2030-01-01T08:00:00.000Z',
};
const detail: ChangeSetDetail = {
  id: ID,
  status: 'pending_approval',
  hash: HASH,
  operation: { id: 'catalog.update' },
  connection: 'shop',
  request: { args: {}, requester: 'ann', createdAt: '2030-01-01T00:00:00.000Z' },
  stats: { total: 2, included: 2, excluded: {}, written: 0, failed: 0, skipped: 0 },
  expiresAt: '2030-02-01T00:00:00.000Z',
  viewer: { canDecide: true, reason: null, fresh: true, stepUpSatisfied: true, canStart: false },
};

interface Answer {
  status: number;
  body: unknown;
}
const ok = (body: unknown): Answer => ({ status: 200, body });

/** Stubs fetch: `answers` maps "METHOD path" (query stripped) to the answer. */
function stubFetch(answers: Record<string, Answer>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0] ?? ''}`;
    const a = answers[key] ?? { status: 500, body: {} };
    return Promise.resolve(new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const base = (): Record<string, Answer> => ({
  'GET /api/v1/session': ok(session),
  [`GET /api/v1/changesets/${ID}`]: ok(detail),
  [`GET /api/v1/changesets/${ID}/items`]: ok({ items: [] }),
  [`GET /api/v1/changesets/${ID}/sample`]: ok({ seed: 'b'.repeat(32), items: [] }),
});

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  assign = vi.fn();
  // The pages only call location.assign; jsdom's own assign cannot be spied on.
  vi.spyOn(window, 'location', 'get').mockReturnValue({ assign } as unknown as Location);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ChangeSetPage', () => {
  it('AUTH-6 a step_up_required answer sends the browser to the fresh login of this page', async () => {
    stubFetch({ ...base(), [`POST /api/v1/changesets/${ID}/decision`]: { status: 403, body: { error: 'step_up_required' } } });
    render(<ChangeSetPage id={ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve 2 changes' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(`/auth/login?return_to=${RETURN_TO}&fresh=1`);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('APR-6 a successful decision reloads the detail', async () => {
    const fetchMock = stubFetch({ ...base(), [`POST /api/v1/changesets/${ID}/decision`]: ok({ status: 'approved' }) });
    render(<ChangeSetPage id={ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve 2 changes' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => url === `/api/v1/changesets/${ID}`)).toHaveLength(2);
    });
  });

  it('UI-7 a 404 shows "Change-set not found."', async () => {
    stubFetch({ ...base(), [`GET /api/v1/changesets/${ID}`]: { status: 404, body: { error: 'not_found' } } });
    render(<ChangeSetPage id={ID} />);
    expect(await screen.findByText('Change-set not found.')).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it('UI-7 a 401 starts a login back to this page', async () => {
    stubFetch({ ...base(), [`GET /api/v1/changesets/${ID}/items`]: { status: 401, body: {} } });
    render(<ChangeSetPage id={ID} />);
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(`/auth/login?return_to=${RETURN_TO}`);
    });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('UI-7 a server error shows an error state, never a login', async () => {
    stubFetch({ ...base(), [`GET /api/v1/changesets/${ID}/sample`]: { status: 503, body: {} } });
    render(<ChangeSetPage id={ID} />);
    expect((await screen.findByRole('alert')).textContent).toBe('The page could not be loaded.');
    expect(assign).not.toHaveBeenCalled();
  });
});
