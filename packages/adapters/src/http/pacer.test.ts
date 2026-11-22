// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { afterEach, describe, expect, it } from 'vitest';
import { clearPacers, Pacer, pacerFor } from './pacer.js';

afterEach(() => {
  clearPacers();
});

describe('CONN-6 pacing', () => {
  it('CONN-6 books FIFO slots one interval apart', () => {
    const p = new Pacer(100);
    expect(p.reserve(1000, 5000)).toBe(0);
    expect(p.reserve(1000, 5000)).toBe(100);
    expect(p.reserve(1000, 5000)).toBe(200);
    expect(p.reserve(1250, 5000)).toBe(50);
  });

  it('CONN-6 books nothing when the slot is too far away', () => {
    const q = new Pacer(1000);
    q.reserve(0, 10_000);
    expect(q.reserve(0, 500)).toBeUndefined();
    expect(q.reserve(0, 10_000)).toBe(1000);
  });

  it('CONN-6 holds the whole connection until a Retry-After time', () => {
    const r = new Pacer(0);
    r.holdUntil(3000);
    expect(r.reserve(1000, 10_000)).toBe(2000);
  });

  it('CONN-6 holdUntil never moves the next slot earlier', () => {
    const r = new Pacer(1000);
    r.reserve(0, 10_000);
    r.reserve(0, 10_000);
    r.holdUntil(500);
    expect(r.reserve(0, 10_000)).toBe(2000);
  });

  it('CONN-6 spaces twenty simultaneous callers', () => {
    const s = new Pacer(50);
    expect(Array.from({ length: 20 }, () => s.reserve(0, 60_000))).toEqual(Array.from({ length: 20 }, (_, i) => i * 50));
  });

  it('CONN-6 gives one pacer per connection and applies a changed interval', () => {
    const a = pacerFor('c1', 100);
    expect(pacerFor('c1', 200)).toBe(a);
    expect(pacerFor('c2', undefined)).not.toBe(a);
    a.reserve(0, 1000);
    expect(a.reserve(0, 1000)).toBe(200);
    pacerFor('c1', undefined);
    expect(a.reserve(0, 1000)).toBe(400);
  });
});
