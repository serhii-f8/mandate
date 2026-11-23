// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { InMemoryFileStore } from '@mandate/testing';
import { fileRows } from './file-rows.js';

const CHANGESET = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function stage(store: InMemoryFileStore, id: string, name: string): Promise<void> {
  await store.stage(
    { id, owner: 'u', name, mediaType: 'image/png', content: PNG, sha256: `sha256:${'a'.repeat(64)}`, preview: 'image', createdAt: new Date('2026-01-01T00:00:00Z'), quota: { count: 10, bytes: 10_000 } },
    { id: 'x', actor: 'u', action: 'file.staged', outcome: 'ok', correlationId: 'c', details: {} },
  );
}

describe('APR-5 UI-7 the file rows of a change-set', () => {
  it('APR-5 lists rows in pointer order with the staged metadata and no content', async () => {
    const store = new InMemoryFileStore();
    await stage(store, A, 'a.png');
    await stage(store, B, 'b.png');
    store.linkFor(CHANGESET, [{ pointer: '/z', fileId: A }, { pointer: '/b', fileId: B }], () => ({ final: false }));
    const rows = await fileRows(store, CHANGESET);
    expect(rows.map((r) => r.pointer)).toEqual(['/b', '/z']);
    expect(rows[0]).toEqual({ pointer: '/b', id: B, name: 'b.png', mediaType: 'image/png', size: PNG.length, sha256: `sha256:${'a'.repeat(64)}`, preview: 'image', available: true });
  });

  it('APR-5 a purged file reads available: false', async () => {
    const store = new InMemoryFileStore();
    await stage(store, A, 'a.png');
    store.linkFor(CHANGESET, [{ pointer: '/image', fileId: A }], () => ({ final: true, endedAt: new Date('2026-01-02T00:00:00Z') }));
    await store.purge({ now: new Date('2026-06-01T00:00:00Z'), stagedTtlHours: 24, keepDays: 7, limit: 10 }, () => ({ id: 'y', actor: 'system', action: 'files.purged', outcome: 'ok', correlationId: 'c', details: {} }));
    expect((await fileRows(store, CHANGESET))[0]?.available).toBe(false);
  });

  it('APR-5 a change-set without files has no rows', async () => {
    expect(await fileRows(new InMemoryFileStore(), CHANGESET)).toEqual([]);
  });
});
