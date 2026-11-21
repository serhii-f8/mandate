// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import type { ChangeItemRecord } from './model.js';
import { hashStoredItems } from './verify.js';

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
});
