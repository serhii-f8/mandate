// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ManifestAction } from '../policy-model.js';
import { ChangeSetHasher, type HashableItem, type HashVersion } from './hash.js';

const item = (over: Partial<HashableItem> = {}): HashableItem => ({
  targetId: 'A',
  status: 'pending',
  before: { f: 1 },
  after: { f: 2 },
  ...over,
});
const digest = (op: string, args: unknown, items: HashableItem[]): string => {
  const h = new ChangeSetHasher(op, args);
  for (const i of items) h.add(i);
  return h.digest();
};

describe('CS-4 change-set hash', () => {
  it('CS-4 is deterministic and well formed', () => {
    const a = digest('op.x', { k: 1 }, [item(), item({ targetId: 'B' })]);
    expect(a).toBe(digest('op.x', { k: 1 }, [item(), item({ targetId: 'B' })]));
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('CS-4 changes with any content change', () => {
    const base = digest('op.x', {}, [item()]);
    expect(digest('op.x', {}, [item({ before: { f: 9 } })])).not.toBe(base);
    expect(digest('op.x', {}, [item({ status: 'unchanged' })])).not.toBe(base);
    expect(digest('op.x', {}, [item({ reason: 'r' })])).not.toBe(base);
    expect(digest('op.y', {}, [item()])).not.toBe(base);
    expect(digest('op.x', { a: 1 }, [item()])).not.toBe(base);
  });
  it('CS-4 rejects items out of order', () => {
    const h = new ChangeSetHasher('op.x', {});
    h.add(item({ targetId: 'B' }));
    expect(() => {
      h.add(item({ targetId: 'A' }));
    }).toThrow();
  });
  it('CS-4 matches the golden digest', () => {
    const text =
      '{"args":{},"format":"mandate.changeset.v1","operation":"op.x"}\n{"after":{"f":2},"before":{"f":1},"status":"pending","target":"A"}\n';
    expect(digest('op.x', {}, [item()])).toBe(`sha256:${createHash('sha256').update(text).digest('hex')}`);
  });
});

describe('CS-4 hash version', () => {
  const sealed = (seal?: { version: HashVersion; action?: ManifestAction }): string => {
    const h = seal === undefined ? new ChangeSetHasher('op.x', {}) : new ChangeSetHasher('op.x', {}, seal);
    h.add(item());
    return h.digest();
  };
  const V1_VECTOR = `sha256:${createHash('sha256')
    .update(
      '{"args":{},"format":"mandate.changeset.v1","operation":"op.x"}\n{"after":{"f":2},"before":{"f":1},"status":"pending","target":"A"}\n',
    )
    .digest('hex')}`;
  // Computed once from the version 2 header and the item line above; never regenerate.
  const V2_VECTOR = 'sha256:95d1f47199d8b1992d89ea1106492772bf70fddc91ebf290a867545bd9df8de7';

  it('CS-4 reproduces the version 1 vector without a seal and with version 1', () => {
    expect(sealed()).toBe(V1_VECTOR);
    expect(sealed({ version: 1, action: 'update' })).toBe(V1_VECTOR);
    expect(sealed({ version: 1, action: 'create' })).toBe(V1_VECTOR);
  });
  it('CS-4 version 2 differs from version 1 and binds the action', () => {
    const update = sealed({ version: 2, action: 'update' });
    expect(update).not.toBe(V1_VECTOR);
    expect(sealed({ version: 2, action: 'create' })).not.toBe(update);
    expect(sealed({ version: 2 })).not.toBe(update);
  });
  it('CS-4 matches the version 2 golden digest', () => {
    expect(sealed({ version: 2, action: 'update' })).toBe(V2_VECTOR);
  });
  it('CS-4 version 2 without an action hashes action null (opaque)', () => {
    const text =
      '{"action":null,"args":{},"format":"mandate.changeset.v2","operation":"op.x"}\n{"after":{"f":2},"before":{"f":1},"status":"pending","target":"A"}\n';
    expect(sealed({ version: 2 })).toBe(`sha256:${createHash('sha256').update(text).digest('hex')}`);
  });
});
