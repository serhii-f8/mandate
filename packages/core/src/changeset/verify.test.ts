// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { ManifestAction } from '../policy-model.js';
import { ChangeSetHasher, type HashVersion } from './hash.js';
import type { ChangeItemRecord } from './model.js';
import { hashStoredItems, UnknownHashVersionError } from './verify.js';

describe('CS-4 stored item hash', () => {
  it('CS-4 hashStoredItems equals the preparation hash after items were written or failed', async () => {
    const items: ChangeItemRecord[] = ['A', 'B', 'C'].map((t) => ({
      targetId: t,
      status: 'pending',
      before: { d: 'old' },
      after: { d: 'new' },
    }));
    const repo = { itemsPage: () => Promise.resolve(items) };
    const cs = { id: 'cs-1', operation: 'catalog.update_content', args: { skus: ['A', 'B', 'C'] } };
    const prepared = await hashStoredItems(repo, cs);
    items[0] = { ...items[0], status: 'written' } as ChangeItemRecord;
    items[1] = { ...items[1], status: 'failed' } as ChangeItemRecord;
    expect(await hashStoredItems(repo, cs)).toBe(prepared);
  });

  describe('CS-4 hash version', () => {
    const items: ChangeItemRecord[] = [{ targetId: 'A', status: 'pending', before: { d: 'old' }, after: { d: 'new' } }];
    const repo = { itemsPage: () => Promise.resolve(items) };
    const base = { id: 'cs-1', operation: 'catalog.update_content', args: { skus: ['A'] } };
    const direct = (seal?: { version: HashVersion; action?: ManifestAction }): string => {
      const h = seal === undefined ? new ChangeSetHasher(base.operation, base.args) : new ChangeSetHasher(base.operation, base.args, seal);
      for (const i of items) h.add(i);
      return h.digest();
    };

    it('CS-4 a version 1 change-set verifies against its version 1 hash', async () => {
      expect(await hashStoredItems(repo, { ...base, hashVersion: 1, action: 'update' })).toBe(direct());
      expect(await hashStoredItems(repo, base)).toBe(direct());
    });
    it('CS-4 a version 2 change-set verifies against its version 2 hash', async () => {
      const v2 = await hashStoredItems(repo, { ...base, hashVersion: 2, action: 'update' });
      expect(v2).toBe(direct({ version: 2, action: 'update' }));
      expect(v2).not.toBe(direct());
    });
    it('CS-4 an unknown hash version rejects with UnknownHashVersionError', async () => {
      // A row from a newer release, or a corrupted one: the type does not admit 3, the database does.
      const unknown = { ...base, hashVersion: 4 as never };
      await expect(hashStoredItems(repo, unknown)).rejects.toBeInstanceOf(UnknownHashVersionError);
    });
  });
});
