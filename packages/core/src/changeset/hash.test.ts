// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ChangeSetHasher, type HashableItem } from './hash.js';

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
      '{"args":{},"format":"aiops.changeset.v1","operation":"op.x"}\n{"after":{"f":2},"before":{"f":1},"status":"pending","target":"A"}\n';
    expect(digest('op.x', {}, [item()])).toBe(`sha256:${createHash('sha256').update(text).digest('hex')}`);
  });
});
