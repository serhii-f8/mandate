// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import type { RecordedExchange } from '@aiops/testing';
import { recording, replay, type ReplayExchange } from '../test/replay.ts';
import { setLabels } from './labels.ts';

/** A repository label as Gitea answers it. */
const label = (id: number, name: string): Record<string, unknown> => ({ id, name, color: 'ee0701', description: '', exclusive: false, is_archived: false });

/** The five seeded labels, ids 1..5 (`bug`, `docs`, `feature`, `triage`, `wontfix`). */
const SEEDED = ['bug', 'docs', 'feature', 'triage', 'wontfix'].map((name, i) => label(i + 1, name));

const labelsPage = (page: number, body: unknown, repo = 'website'): RecordedExchange => ({
  request: { method: 'GET', path: `/repos/acme/${repo}/labels`, query: { page: String(page), limit: '50' } },
  response: { status: 200, body },
});

const put = (n: number, ids: number[], status: number, body: unknown, repo = 'website'): RecordedExchange => ({
  request: { method: 'PUT', path: `/repos/acme/${repo}/issues/${n}/labels`, body: { labels: ids } },
  response: { status, body },
});

const rec = (number: number, labels: string[], repo = 'website'): Record<string, unknown> => ({ number, labels, owner: 'acme', repo });

/** The ids of the named labels in a recorded label list. */
function idsOf(body: unknown, names: string[]): number[] {
  const list = body as { id: number; name: string }[];
  return names.map((n) => {
    const found = list.find((l) => l.name === n);
    if (found === undefined) throw new Error(`no recorded label ${n}`);
    return found.id;
  });
}

function puts(exchanges: readonly ReplayExchange[]): number {
  return exchanges.filter((e) => e.request.method === 'PUT').length;
}

describe('OPS-5 OPS-6 Gitea label writer', () => {
  it('OPS-5 resolves names to ids and PUTs ids (set-labels-30)', async () => {
    const exchanges = await recording('write/set-labels-30');
    const [list, write] = exchanges;
    expect(write?.request.body).toEqual({ labels: idsOf(list?.response.body, ['bug', 'docs']) });
    const r = replay(exchanges);
    const outcomes = await setLabels(r.ctx, [rec(30, ['bug', 'docs'])], {});
    expect(outcomes).toEqual(['ok']);
    expect(r.pending()).toBe(0);
  });

  it('OPS-5 an unknown name fails the record without a PUT (set-labels-unknown-name)', async () => {
    const exchanges = await recording('write/set-labels-unknown-name');
    expect(exchanges).toHaveLength(1);
    const r = replay(exchanges);
    const outcomes = await setLabels(r.ctx, [rec(30, ['feature', 'no-such-label'])], {});
    expect(outcomes).toEqual(['failed']);
    expect(r.calls()).toBe(1);
    expect(r.pending()).toBe(0);
  });

  it('OPS-5 a name that matches only case-insensitively is unknown', async () => {
    const r = replay([labelsPage(1, SEEDED)]);
    expect(await setLabels(r.ctx, [rec(30, ['Bug'])], {})).toEqual(['failed']);
    expect(r.calls()).toBe(1);
  });

  it('OPS-5 label resolution pages until a short page', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => label(i + 1, `label-${String(i + 1).padStart(2, '0')}`));
    const exchanges = [labelsPage(1, page1), labelsPage(2, [label(51, 'page-two')]), put(30, [51, 3], 200, [label(3, 'label-03'), label(51, 'page-two')])];
    const r = replay(exchanges);
    expect(await setLabels(r.ctx, [rec(30, ['page-two', 'label-03'])], {})).toEqual(['ok']);
    expect(r.pending()).toBe(0);
  });

  it('OPS-5 a 2xx answer that differs from the request is ok so core verifies it', async () => {
    // The write landed (maybe partially): `failed` would record it as refused and skip core's verify read.
    const r = replay([labelsPage(1, SEEDED), put(30, [3, 1], 200, [label(3, 'feature')])]);
    expect(await setLabels(r.ctx, [rec(30, ['feature', 'bug'])], {})).toEqual(['ok']);
    expect(r.pending()).toBe(0);
  });

  it('OPS-5 a 2xx answer that is not a label list is ok so core verifies it', async () => {
    const r = replay([labelsPage(1, SEEDED), put(30, [1], 200, { message: 'ok' })]);
    expect(await setLabels(r.ctx, [rec(30, ['bug'])], {})).toEqual(['ok']);
    expect(r.pending()).toBe(0);
  });

  it('OPS-5 a reordered label set writes and verifies as ok', async () => {
    // Writer outcome only (F8): core's order-sensitive verify read may still mark the item drift.
    const r = replay([labelsPage(1, SEEDED), put(3, [4, 1], 200, [label(1, 'bug'), label(4, 'triage')])]);
    expect(await setLabels(r.ctx, [rec(3, ['triage', 'bug'])], {})).toEqual(['ok']);
    expect(r.pending()).toBe(0);
  });

  it('OPS-6 a retriable failure mid-batch keeps order and stops sending', async () => {
    const exchanges = [labelsPage(1, SEEDED), put(1, [1], 200, [label(1, 'bug')]), put(2, [2], 503, null)];
    const r = replay(exchanges);
    const outcomes = await setLabels(r.ctx, [rec(1, ['bug']), rec(2, ['docs']), rec(3, ['feature'])], {});
    expect(outcomes).toEqual(['ok', 'retriable', 'retriable']);
    expect(puts(exchanges)).toBe(2);
    expect(r.calls()).toBe(3);
    expect(r.pending()).toBe(0);
  });

  it('OPS-6 a transport failure (timeout, network, busy) or 429 on a PUT is retriable', async () => {
    for (const response of [{ code: 'timeout' as const }, { code: 'network' as const }, { code: 'busy' as const }, { code: 'http_status' as const, status: 429 }]) {
      const r = replay([labelsPage(1, SEEDED), { request: put(1, [1], 200, null).request, response }]);
      expect(await setLabels(r.ctx, [rec(1, ['bug']), rec(2, ['docs'])], {})).toEqual(['retriable', 'retriable']);
      expect(r.pending()).toBe(0);
    }
  });

  it('OPS-6 a 4xx on a PUT fails that record and the batch continues', async () => {
    const r = replay([labelsPage(1, SEEDED), put(1, [1], 403, null), put(2, [2], 200, [label(2, 'docs')])]);
    expect(await setLabels(r.ctx, [rec(1, ['bug']), rec(2, ['docs'])], {})).toEqual(['failed', 'ok']);
    expect(r.pending()).toBe(0);
  });

  it('OPS-6 a label read failure decides the group: retriable on 5xx, failed on 4xx', async () => {
    const down = replay([{ request: labelsPage(1, []).request, response: { status: 502, body: null } }]);
    expect(await setLabels(down.ctx, [rec(1, ['bug']), rec(2, ['docs'])], {})).toEqual(['retriable', 'retriable']);
    expect(down.pending()).toBe(0);
    const denied = replay([{ request: labelsPage(1, []).request, response: { status: 403, body: null } }]);
    expect(await setLabels(denied.ctx, [rec(1, ['bug']), rec(2, ['docs'])], {})).toEqual(['failed', 'failed']);
    expect(denied.pending()).toBe(0);
  });

  it('OPS-6 a retriable label-list read in one repository stops sending for a later repository', async () => {
    const r = replay([{ request: labelsPage(1, []).request, response: { code: 'timeout' } }]);
    const outcomes = await setLabels(r.ctx, [rec(1, ['bug']), rec(2, ['docs'], 'internal')], {});
    expect(outcomes).toEqual(['retriable', 'retriable']);
    expect(r.calls()).toBe(1);
    expect(r.pending()).toBe(0);
  });

  it('OPS-5 a label list that never ends with a short page fails after 20 pages without a PUT', async () => {
    const full = (page: number): RecordedExchange =>
      labelsPage(page, Array.from({ length: 50 }, (_, i) => label((page - 1) * 50 + i + 1, `label-${String((page - 1) * 50 + i + 1)}`)));
    const r = replay(Array.from({ length: 20 }, (_, i) => full(i + 1)));
    expect(await setLabels(r.ctx, [rec(1, ['label-1'])], {})).toEqual(['failed']);
    expect(r.calls()).toBe(20);
    expect(r.pending()).toBe(0);
  });

  it('OPS-5 a malformed label list fails the group without a PUT', async () => {
    const r = replay([labelsPage(1, [{ id: 'x', name: 'bug' }])]);
    expect(await setLabels(r.ctx, [rec(1, ['bug'])], {})).toEqual(['failed']);
    expect(r.calls()).toBe(1);
  });

  it('OPS-6 records of two repositories resolve labels per repository, outcomes in input order', async () => {
    const internal = [label(11, 'bug'), label(12, 'docs')];
    const exchanges = [
      labelsPage(1, SEEDED),
      put(1, [1], 200, [label(1, 'bug')]),
      labelsPage(1, internal, 'internal'),
      put(2, [12], 200, [label(12, 'docs')], 'internal'),
      put(3, [2], 200, [label(2, 'docs')]),
    ];
    const r = replay(exchanges);
    const outcomes = await setLabels(r.ctx, [rec(1, ['bug']), rec(2, ['docs'], 'internal'), rec(3, ['docs'])], {});
    expect(outcomes).toEqual(['ok', 'ok', 'ok']);
    expect(r.pending()).toBe(0);
  });

  it('OPS-6 an empty label list clears and is ok', async () => {
    const r = replay([labelsPage(1, SEEDED), put(30, [], 200, [])]);
    expect(await setLabels(r.ctx, [rec(30, [])], {})).toEqual(['ok']);
    expect(r.pending()).toBe(0);
  });

  it('OPS-5 a record without carried owner or repo fails without a request', async () => {
    const r = replay([labelsPage(1, SEEDED), put(4, [1], 200, [label(1, 'bug')])]);
    const outcomes = await setLabels(
      r.ctx,
      [
        { number: 1, labels: ['bug'], repo: 'website' },
        { number: 2, labels: ['bug'], owner: 'acme' },
        { number: 3, labels: ['bug'], owner: 'acme', repo: '..' },
        { number: '5', labels: ['bug'], owner: 'acme', repo: 'website' },
        { number: 6, labels: 'bug', owner: 'acme', repo: 'website' },
        { number: 7, labels: [1], owner: 'acme', repo: 'website' },
        rec(4, ['bug']),
      ],
      {},
    );
    expect(outcomes).toEqual(['failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'ok']);
    expect(r.calls()).toBe(2);
    expect(r.pending()).toBe(0);
  });

  it('OPS-6 an empty batch sends nothing', async () => {
    const r = replay([]);
    expect(await setLabels(r.ctx, [], {})).toEqual([]);
    expect(r.calls()).toBe(0);
  });
});
