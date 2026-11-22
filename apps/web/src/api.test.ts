// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { BadQuery, createApi, loginUrl, NotFound, Unauthenticated } from './api.js';

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

  it('UI-3 submit posts the hash with the CSRF token and maps 200 and 409', async () => {
    const url = `https://ops.example.test/app/changesets/${ID}`;
    const { calls, api } = fake(200, { status: 'pending_approval', approval: { step: 1, steps: ['content_lead'], url } });
    expect(await api.submit('tok', ID, HASH)).toEqual({ ok: true, status: 'pending_approval', approvalUrl: url });
    const call = calls[0];
    expect(call?.url).toBe(`/api/v1/changesets/${ID}/submit`);
    expect(call?.init?.method).toBe('POST');
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('tok');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(call?.init?.body as string)).toEqual({ hash: HASH });
    expect(await fake(200, { status: 'executing' }).api.submit('tok', ID, HASH)).toEqual({ ok: true, status: 'executing' });
    expect(await fake(409, { error: 'hash_mismatch' }).api.submit('tok', ID, HASH)).toEqual({ ok: false, error: 'hash_mismatch' });
    await expect(fake(401, {}).api.submit('tok', ID, HASH)).rejects.toBeInstanceOf(Unauthenticated);
  });

  it('CS-5 exclude posts hash and lists, returns the new id and hash on 201, error and count on 409', async () => {
    const NEW = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    const NEW_HASH = `sha256:${'b'.repeat(64)}`;
    const { calls, api } = fake(201, { id: NEW, hash: NEW_HASH, stats: {}, derivedFrom: ID });
    expect(await api.exclude('tok', ID, { hash: HASH, exclude: ['sku-1'], include: [] })).toEqual({ ok: true, id: NEW, hash: NEW_HASH });
    const call = calls[0];
    expect(call?.url).toBe(`/api/v1/changesets/${ID}/exclusions`);
    expect(call?.init?.method).toBe('POST');
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('tok');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(call?.init?.body as string)).toEqual({ hash: HASH, exclude: ['sku-1'] });
    const both = fake(201, { id: NEW, hash: NEW_HASH });
    await both.api.exclude('tok', ID, { hash: HASH, exclude: [], include: ['sku-2'] });
    expect(JSON.parse(both.calls[0]?.init?.body as string)).toEqual({ hash: HASH, include: ['sku-2'] });
    expect(await fake(409, { error: 'unknown_items', count: 2 }).api.exclude('tok', ID, { hash: HASH, exclude: ['x', 'y'], include: [] })).toEqual({
      ok: false,
      error: 'unknown_items',
      count: 2,
    });
    expect(await fake(409, { error: 'nothing_left' }).api.exclude('tok', ID, { hash: HASH, exclude: ['x'], include: [] })).toEqual({
      ok: false,
      error: 'nothing_left',
    });
    await expect(fake(401, {}).api.exclude('tok', ID, { hash: HASH, exclude: ['x'], include: [] })).rejects.toBeInstanceOf(Unauthenticated);
  });

  it('CS-8 exportUrl encodes the id and names the format', () => {
    const { api } = fake(200, {});
    expect(api.exportUrl(ID, 'csv')).toBe(`/api/v1/changesets/${ID}/export?format=csv`);
    expect(api.exportUrl('a/b c', 'xlsx')).toBe('/api/v1/changesets/a%2Fb%20c/export?format=xlsx');
  });

  it('UI-2 AUD-6 audit leaves empty filters out and passes the cursor', async () => {
    const { calls, api } = fake(200, { events: [] });
    await api.audit({ actor: 'bob', action: '', cursor: 'c1' });
    expect(calls[0]?.url).toBe('/api/v1/audit?actor=bob&cursor=c1');
    await api.audit({});
    expect(calls[1]?.url).toBe('/api/v1/audit');
    expect(api.auditExportUrl({ outcome: 'denied', from: '' })).toBe('/api/v1/audit/export?outcome=denied');
    expect(api.auditExportUrl({})).toBe('/api/v1/audit/export');
  });

  it('UI-2 audit: a 400 throws BadQuery, a 401 throws Unauthenticated', async () => {
    await expect(fake(400, {}).api.audit({})).rejects.toBeInstanceOf(BadQuery);
    await expect(fake(401, {}).api.audit({})).rejects.toBeInstanceOf(Unauthenticated);
  });
});
