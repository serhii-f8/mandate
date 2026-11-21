// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import type { RecordedExchange } from '@aiops/testing';
import { recording, replay } from '../test/replay.ts';
import { getIssues, searchIssues } from './reads.ts';

const ISSUE_KEYS = ['labels', 'number', 'owner', 'repo', 'state', 'title', 'updated_at'];

/** The recorded body of `GET /repos/acme/website/issues/<n>` from the get-many recording. */
async function recordedIssue(n: number): Promise<Record<string, unknown>> {
  const found = (await recording('get-many-website')).find((e) => e.request.path === `/repos/acme/website/issues/${n}`);
  if (found === undefined) throw new Error(`no recorded issue ${n}`);
  return structuredClone(found.response.body) as Record<string, unknown>;
}

const getOne = (n: number, status: number, body: unknown): RecordedExchange => ({
  request: { method: 'GET', path: `/repos/acme/website/issues/${n}` },
  response: { status, body },
});

describe('OPS-5 Gitea code reads', () => {
  it('OPS-5 search sends the recorded request and maps issues with sorted label names', async () => {
    const r = replay(await recording('search-website-bug-open'));
    const result = await searchIssues(r.ctx, { owner: 'acme', repo: 'website', labels: ['bug'], fields: ['number', 'title', 'state', 'labels'], limit: 50 });
    expect(r.pending()).toBe(0);
    expect(result.total).toBeUndefined();
    expect(result.items.map((i) => i.number)).toEqual([28, 26, 18, 16, 13, 11, 8, 6, 3, 1]);
    for (const item of result.items) {
      expect(Object.keys(item).sort()).toEqual(ISSUE_KEYS);
      const labels = item.labels as unknown[];
      expect(labels.every((l) => typeof l === 'string')).toBe(true);
      expect(labels).toEqual([...(labels as string[])].sort());
      expect(labels).toContain('bug');
      expect(item).toMatchObject({ owner: 'acme', repo: 'website', state: 'open' });
    }
    expect(result.items.find((i) => i.number === 28)?.labels).toEqual(['bug', 'triage']);
  });

  it('OPS-5 search page 2 of all states', async () => {
    const r = replay(await recording('search-website-all-page-2'));
    const result = await searchIssues(r.ctx, { owner: 'acme', repo: 'website', state: 'all', page: 2, limit: 10, fields: ['number'] });
    expect(r.pending()).toBe(0);
    expect(result.items.map((i) => i.number)).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
  });

  it('OPS-5 search applies the defaults state=open, page=1, limit=30 and sends q', async () => {
    const r = replay([
      {
        request: { method: 'GET', path: '/repos/acme/website/issues', query: { state: 'open', type: 'issues', page: '1', limit: '30', labels: 'bug,docs', q: 'issue 0' } },
        response: { status: 200, body: [] },
      },
    ]);
    const result = await searchIssues(r.ctx, { owner: 'acme', repo: 'website', labels: ['bug', 'docs'], q: 'issue 0', fields: ['number'] });
    expect(r.pending()).toBe(0);
    expect(result.items).toEqual([]);
  });

  it('OPS-6 get_many omits 404s and pull requests', async () => {
    const pr = { ...(await recordedIssue(1)), number: 5, pull_request: {} };
    const r = replay([...(await recording('get-many-website')), getOne(5, 200, pr)]);
    const result = await getIssues(r.ctx, { owner: 'acme', repo: 'website', numbers: ['1', '3', '999', '5'], fields: ['number', 'title', 'state', 'labels'] });
    expect(r.pending()).toBe(0);
    expect(result.items.map((i) => i.number)).toEqual([1, 3]);
    expect(result.items[1]?.labels).toEqual(['bug', 'triage']);
    for (const item of result.items) expect(Object.keys(item).sort()).toEqual(ISSUE_KEYS);
  });

  it('POL-2 owner and repo of each item come from the upstream repository, not from the arguments', async () => {
    const raw = await recordedIssue(1);
    const moved = { ...raw, repository: { ...(raw.repository as Record<string, unknown>), name: 'internal', full_name: 'acme/internal' } };
    const r = replay([getOne(1, 200, moved)]);
    const result = await getIssues(r.ctx, { owner: 'acme', repo: 'website', numbers: ['1'], fields: ['number', 'owner', 'repo'] });
    expect(result.items).toEqual([expect.objectContaining({ number: 1, owner: 'acme', repo: 'internal' })]);
  });

  it('OPS-5 malformed arguments throw before any request', async () => {
    const r = replay([]);
    const base = { owner: 'acme', repo: 'website', fields: ['number'] };
    await expect(getIssues(r.ctx, { ...base, numbers: ['0'] })).rejects.toThrow(TypeError);
    await expect(getIssues(r.ctx, { ...base, owner: 'acme/x', numbers: ['1'] })).rejects.toThrow(TypeError);
    await expect(getIssues(r.ctx, { ...base, repo: '..', numbers: ['1'] })).rejects.toThrow(TypeError);
    await expect(getIssues(r.ctx, { ...base, numbers: [1] })).rejects.toThrow(TypeError);
    await expect(getIssues(r.ctx, { ...base, numbers: ['1', '1'] })).rejects.toThrow(TypeError);
    await expect(searchIssues(r.ctx, { ...base, limit: 51 })).rejects.toThrow(TypeError);
    await expect(searchIssues(r.ctx, { ...base, owner: 'acme/x' })).rejects.toThrow(TypeError);
    await expect(searchIssues(r.ctx, { ...base, page: 0 })).rejects.toThrow(TypeError);
    await expect(searchIssues(r.ctx, { ...base, state: 'merged' })).rejects.toThrow(TypeError);
    // A comma would split one name into several and widen the selector.
    await expect(searchIssues(r.ctx, { ...base, labels: ['bug,docs'] })).rejects.toThrow(TypeError);
    await expect(searchIssues(r.ctx, { ...base, extra: 1 })).rejects.toThrow(TypeError);
    await expect(searchIssues(r.ctx, { owner: 'acme', repo: 'website' })).rejects.toThrow(TypeError);
    expect(r.calls()).toBe(0);
  });

  it('OPS-5 a 500 from get_many throws an error without upstream text', async () => {
    const r = replay([getOne(1, 500, { message: 'upstream-secret-detail' })]);
    const err = await getIssues(r.ctx, { owner: 'acme', repo: 'website', numbers: ['1', '3'], fields: ['number'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).not.toContain('upstream-secret-detail');
    expect((err as Error).message).toContain('500');
    expect(r.calls()).toBe(1);
  });

  it('OPS-5 a malformed issue body throws instead of being dropped', async () => {
    const r = replay([getOne(1, 200, { ...(await recordedIssue(1)), state: 'weird' })]);
    await expect(getIssues(r.ctx, { owner: 'acme', repo: 'website', numbers: ['1'], fields: ['number'] })).rejects.toThrow(/invalid/);
  });
});
