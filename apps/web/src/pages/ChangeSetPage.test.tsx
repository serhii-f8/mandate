// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
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
  viewAudit: false,
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
  rollback: { available: false },
  viewer: { canDecide: true, reason: null, fresh: true, stepUpSatisfied: true, canStart: false, canSubmit: false, canExclude: false },
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

  it('UI-2 APR-5 an approver whose change-set changes status sees the fresh items', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let answer: ChangeSetDetail = detail;
      let itemsAnswer: unknown = { items: [] };
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const path = url.split('?')[0] ?? '';
          const body =
            path === '/api/v1/session'
              ? session
              : path === `/api/v1/changesets/${ID}`
                ? answer
                : path === `/api/v1/changesets/${ID}/items`
                  ? itemsAnswer
                  : { seed: 'b'.repeat(32), items: [] };
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
        }),
      );
      render(<ChangeSetPage id={ID} />);
      expect(await screen.findByRole('button', { name: 'Approve 2 changes' })).toBeTruthy();
      expect(screen.queryByText('TS-9')).toBeNull();
      answer = { ...detail, status: 'approved', viewer: { ...detail.viewer, canDecide: false, reason: 'not_pending' } };
      itemsAnswer = { items: [{ targetId: 'TS-9', status: 'pending', before: { price: '1.00' }, after: { price: '2.00' } }] };
      await vi.advanceTimersByTimeAsync(3000);
      expect(await screen.findByText('TS-9')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('requester', () => {
    const NEW_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    const NEW_HASH = `sha256:${'c'.repeat(64)}`;
    const own: Session = { ...session, subject: 'ann', roles: ['content_editor'] };
    const prepared: ChangeSetDetail = {
      ...detail,
      status: 'prepared',
      viewer: { ...detail.viewer, canDecide: false, reason: 'separation_of_duties', canSubmit: true, canExclude: true },
    };
    const rows = {
      items: [
        { targetId: 'TS-1', status: 'pending', before: { price: '10.00' }, after: { price: '11.00' } },
        { targetId: 'TS-2', status: 'pending', before: { price: '20.00' }, after: { price: '22.00' } },
      ],
    };
    const requesterBase = (): Record<string, Answer> => ({
      ...base(),
      'GET /api/v1/session': ok(own),
      [`GET /api/v1/changesets/${ID}`]: ok(prepared),
      [`GET /api/v1/changesets/${ID}/items`]: ok(rows),
    });
    const posts = (fetchMock: ReturnType<typeof stubFetch>, path: string) =>
      fetchMock.mock.calls.filter(([url, init]) => url === path && init?.method === 'POST');

    it('UI-3 the requester sees the preview and submits through the page route', async () => {
      const fetchMock = stubFetch({
        ...requesterBase(),
        [`POST /api/v1/changesets/${ID}/submit`]: ok({ status: 'pending_approval', approval: { step: 1, steps: ['content_lead'], url: `/app/changesets/${ID}` } }),
      });
      render(<ChangeSetPage id={ID} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Submit 2 changes' }));
      await waitFor(() => {
        expect(posts(fetchMock, `/api/v1/changesets/${ID}/submit`)).toHaveLength(1);
      });
      const init = posts(fetchMock, `/api/v1/changesets/${ID}/submit`)[0]?.[1];
      expect((init?.headers as Record<string, string>)['x-csrf-token']).toBe('tok');
      expect(JSON.parse(init?.body as string)).toEqual({ hash: HASH });
      expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    });

    it('UI-4 SEC-8 the page posts the hash; reauthentication_required sends the browser to a fresh login back to the page', async () => {
      const done: ChangeSetDetail = { ...prepared, status: 'completed', rollback: { available: true, count: 2, until: '2030-01-02T00:00:00.000Z' } };
      const answers = (rollback: Answer): Record<string, Answer> => ({
        ...requesterBase(),
        [`GET /api/v1/changesets/${ID}`]: ok(done),
        [`POST /api/v1/changesets/${ID}/rollback`]: rollback,
      });
      const stale = stubFetch(answers({ status: 403, body: { error: 'reauthentication_required' } }));
      const first = render(<ChangeSetPage id={ID} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Roll back 2 items' }));
      await waitFor(() => {
        expect(assign).toHaveBeenCalledWith(`/auth/login?return_to=${RETURN_TO}&fresh=1`);
      });
      const init = posts(stale, `/api/v1/changesets/${ID}/rollback`)[0]?.[1];
      expect(JSON.parse(init?.body as string)).toEqual({ hash: HASH });
      expect((init?.headers as Record<string, string>)['x-csrf-token']).toBe('tok');
      first.unmount();

      const fine = stubFetch(answers(ok({ status: 'rolling_back' })));
      render(<ChangeSetPage id={ID} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Roll back 2 items' }));
      await waitFor(() => {
        expect(fine.mock.calls.filter(([url]) => url === `/api/v1/changesets/${ID}`)).toHaveLength(2);
      });
    });

    it('CS-5 an exclusion moves the page to the new change-set', async () => {
      const replaceState = vi.spyOn(window.history, 'replaceState');
      const fetchMock = stubFetch({
        ...requesterBase(),
        [`POST /api/v1/changesets/${ID}/exclusions`]: { status: 201, body: { id: NEW_ID, hash: NEW_HASH, derivedFrom: ID } },
        [`GET /api/v1/changesets/${NEW_ID}`]: ok({
          ...prepared,
          id: NEW_ID,
          hash: NEW_HASH,
          derivedFrom: ID,
          stats: { ...prepared.stats, included: 1, excluded: { requester: 1 } },
        }),
        [`GET /api/v1/changesets/${NEW_ID}/items`]: ok({ items: [{ ...rows.items[0], status: 'excluded', reason: 'requester' }, rows.items[1]] }),
      });
      render(<ChangeSetPage id={ID} />);
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Select TS-1' }));
      fireEvent.click(screen.getByRole('button', { name: 'Exclude selected (1)' }));
      expect(await screen.findByText(`New change-set ${NEW_ID.slice(0, 8)}; the previous one is unchanged.`)).toBeTruthy();
      expect(replaceState).toHaveBeenCalledWith(null, '', `/app/changesets/${NEW_ID}`);
      expect(JSON.parse(posts(fetchMock, `/api/v1/changesets/${ID}/exclusions`)[0]?.[1]?.body as string)).toEqual({ hash: HASH, exclude: ['TS-1'] });
      // The new change-set is the current one: its own submit route and count.
      fireEvent.click(screen.getByRole('button', { name: 'Submit 1 change' }));
      await waitFor(() => {
        expect(posts(fetchMock, `/api/v1/changesets/${NEW_ID}/submit`)).toHaveLength(1);
      });
    });

    it('CS-8 export sends the browser to the export route', async () => {
      stubFetch(requesterBase());
      render(<ChangeSetPage id={ID} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Export CSV' }));
      await waitFor(() => {
        expect(assign).toHaveBeenCalledWith(`/api/v1/changesets/${ID}/export?format=csv`);
      });
    });

    it('UI-2 a change-set that finishes preparing shows its items', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        let answer: ChangeSetDetail = { ...prepared, status: 'preparing' };
        let itemsAnswer: unknown = { items: [] };
        const fetchMock = vi.fn((input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const path = url.split('?')[0] ?? '';
          const body =
            path === '/api/v1/session'
              ? own
              : path === `/api/v1/changesets/${ID}`
                ? answer
                : path === `/api/v1/changesets/${ID}/items`
                  ? itemsAnswer
                  : { seed: 'b'.repeat(32), items: [] };
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
        });
        vi.stubGlobal('fetch', fetchMock);
        render(<ChangeSetPage id={ID} />);
        expect(await screen.findByText('Being prepared…')).toBeTruthy();
        answer = prepared;
        itemsAnswer = rows;
        await vi.advanceTimersByTimeAsync(3000);
        expect(await screen.findByRole('checkbox', { name: 'Select TS-1' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Submit 2 changes' })).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('UI-2 polling keeps the items while the status holds and stops after 30 minutes with a Refresh button', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const fetchMock = stubFetch({ ...requesterBase(), [`GET /api/v1/changesets/${ID}`]: ok({ ...prepared, status: 'preparing' }) });
        const count = (path: string) => fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.split('?')[0] === path).length;
        render(<ChangeSetPage id={ID} />);
        expect(await screen.findByText('Being prepared…')).toBeTruthy();
        await vi.advanceTimersByTimeAsync(1_800_000 + 10_000);
        const refresh = await screen.findByRole('button', { name: 'Refresh' });
        const polls = count(`/api/v1/changesets/${ID}`);
        expect(polls).toBeGreaterThan(100);
        expect(count(`/api/v1/changesets/${ID}/items`)).toBe(1);
        fireEvent.click(refresh);
        await vi.advanceTimersByTimeAsync(3000);
        expect(count(`/api/v1/changesets/${ID}`)).toBe(polls + 1);
        expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
