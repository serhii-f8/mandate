import { describe, expect, it } from 'vitest';
import { createApi, loginUrl, NotFound, Unauthenticated } from './api.js';

const ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const HASH = `sha256:${'a'.repeat(64)}`;

function fake(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = ((url: string, init?: RequestInit) => {
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  }) as typeof fetch;
  return { calls, api: createApi(fetcher) };
}

describe('web api client', () => {
  it('AUTH-6 loginUrl carries the encoded return path and fresh=1', () => {
    expect(loginUrl('/app/changesets/abc', true)).toBe('/auth/login?return_to=%2Fapp%2Fchangesets%2Fabc&fresh=1');
    expect(loginUrl('/app/credentials', false)).toBe('/auth/login?return_to=%2Fapp%2Fcredentials');
  });

  it('SEC-8 decide sends the CSRF header and the JSON body', async () => {
    const { calls, api } = fake(200, { status: 'approved' });
    const out = await api.decide('tok', ID, { decision: 'approve', hash: HASH, count: 3 });
    expect(out).toEqual({ ok: true, status: 'approved' });
    const call = calls[0];
    expect(call?.url).toBe(`/api/v1/changesets/${ID}/decision`);
    expect(call?.init?.method).toBe('POST');
    expect((call?.init?.headers as Record<string, string>)['x-csrf-token']).toBe('tok');
    expect(JSON.parse(call?.init?.body as string)).toEqual({ decision: 'approve', hash: HASH, count: 3 });
  });

  it('SEC-8 a 403 reauthentication_required or step_up_required becomes { ok: false, error }', async () => {
    for (const error of ['reauthentication_required', 'step_up_required']) {
      const { api } = fake(403, { error });
      expect(await api.decide('t', ID, { decision: 'reject', hash: HASH, count: 1 })).toEqual({ ok: false, error });
      expect(await api.start('t', ID)).toEqual({ ok: false, error });
    }
    const { api } = fake(500, {});
    expect(await api.start('t', ID)).toEqual({ ok: false, error: 'HTTP 500' });
  });

  it('UI-7 a 404 throws NotFound, a 401 throws Unauthenticated', async () => {
    await expect(fake(404, {}).api.changeset(ID)).rejects.toBeInstanceOf(NotFound);
    await expect(fake(401, {}).api.changeset(ID)).rejects.toBeInstanceOf(Unauthenticated);
    await expect(fake(401, {}).api.approvals()).rejects.toBeInstanceOf(Unauthenticated);
    await expect(fake(401, {}).api.decide('t', ID, { decision: 'approve', hash: HASH, count: 1 })).rejects.toBeInstanceOf(Unauthenticated);
  });

  it('NFR-8 items passes after and status as query parameters', async () => {
    const { calls, api } = fake(200, { items: [] });
    await api.items(ID, { after: 'abc', status: 'failed' });
    await api.items(ID, {});
    expect(calls[0]?.url).toBe(`/api/v1/changesets/${ID}/items?after=abc&status=failed`);
    expect(calls[1]?.url).toBe(`/api/v1/changesets/${ID}/items`);
  });
});
