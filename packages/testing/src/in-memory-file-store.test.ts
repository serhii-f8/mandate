// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Of, type FileLink } from '@mandate/core';
import { fileStoreContract } from './file-store-contract.js';
import { InMemoryFileStore } from './in-memory-file-store.js';

fileStoreContract(() => {
  const store = new InMemoryFileStore();
  const state = new Map<string, { final: boolean; endedAt?: Date }>();
  return Promise.resolve({
    store,
    link: (changesetId: string, links: readonly FileLink[]) => {
      state.set(changesetId, { final: false });
      store.linkFor(changesetId, links, () => state.get(changesetId) ?? { final: false });
      return Promise.resolve();
    },
    endChangeSet: (changesetId: string, at: Date) => {
      state.set(changesetId, { final: true, endedAt: at });
      return Promise.resolve();
    },
  });
});

describe('CS-10 in-memory file store test hooks', () => {
  it('CS-10 corrupt replaces the bytes without touching the stored hash', async () => {
    const store = new InMemoryFileStore();
    const id = randomUUID();
    const bytes = new TextEncoder().encode('abc');
    await store.stage(
      { id, owner: 'o', name: 'n', mediaType: 'text/plain', content: bytes, sha256: sha256Of(bytes), preview: 'text', createdAt: new Date(), quota: { count: 5, bytes: 100 } },
      { id: randomUUID(), actor: 'o', action: 'file.staged', outcome: 'ok', correlationId: 'c', details: {} },
    );
    store.corrupt(id, new TextEncoder().encode('xyz'));
    expect(new TextDecoder().decode(await store.content(id))).toBe('xyz');
    expect((await store.get(id))?.sha256).toBe(sha256Of(bytes));
  });
});
