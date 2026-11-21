// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { Semaphore, semaphoreFor } from './semaphore.js';

describe('CONN-6 semaphore', () => {
  it('grants up to the limit and queues the rest in order', async () => {
    const s = new Semaphore(2);
    const a = await s.acquire(1000);
    const b = await s.acquire(1000);
    expect(a).toBeTypeOf('function');
    expect(b).toBeTypeOf('function');
    const order: string[] = [];
    const c = s.acquire(1000).then((r) => {
      order.push('c');
      return r;
    });
    const d = s.acquire(1000).then((r) => {
      order.push('d');
      return r;
    });
    a?.();
    (await c)?.();
    b?.();
    (await d)?.();
    expect(order).toEqual(['c', 'd']);
  });

  it('returns undefined when no slot frees up within the wait limit', async () => {
    const s = new Semaphore(1);
    const held = await s.acquire(1000);
    expect(await s.acquire(20)).toBeUndefined();
    held?.();
    // the timed-out waiter did not take the slot
    expect(await s.acquire(20)).toBeTypeOf('function');
  });

  it('a release is idempotent', async () => {
    const s = new Semaphore(1);
    const r = await s.acquire(1000);
    r?.();
    r?.();
    const x = await s.acquire(1000);
    expect(await s.acquire(10)).toBeUndefined();
    x?.();
  });

  it('semaphoreFor keeps one semaphore per connection and follows a new limit', async () => {
    const a = semaphoreFor('sem-conn', 1);
    expect(semaphoreFor('sem-conn', 1)).toBe(a);
    const held = await a.acquire(1000);
    semaphoreFor('sem-conn', 2);
    expect(await a.acquire(20)).toBeTypeOf('function');
    held?.();
  });
});
