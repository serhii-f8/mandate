// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RateCounter } from '@mandate/core';

/** A PostgreSQL implementation may share one database across cases: every case uses fresh keys. */
export interface RateCounterHarness {
  readonly counter: RateCounter;
  readonly close?: () => Promise<void>;
}

const WINDOW = new Date('2026-01-01T00:00:00.000Z');
const NEXT_WINDOW = new Date('2026-01-01T00:01:00.000Z');

/** Behavior every RateCounter implementation must have (POL-4 calls_per_minute). */
export function describeRateCounterContract(label: string, setup: () => Promise<RateCounterHarness>): void {
  describe(`POL-4 rate counter contract: ${label}`, () => {
    it('POL-4 hit counts per key and window, starting at 1', async () => {
      const h = await setup();
      try {
        const key = `alice:editor:${randomUUID()}`;
        const other = `bob:editor:${randomUUID()}`;
        expect(await h.counter.hit(key, WINDOW)).toBe(1);
        expect(await h.counter.hit(key, WINDOW)).toBe(2);
        expect(await h.counter.hit(other, WINDOW)).toBe(1);
        expect(await h.counter.hit(key, NEXT_WINDOW)).toBe(1);
        expect(await h.counter.hit(key, new Date(WINDOW.getTime()))).toBe(3);

        const parallel = `carol:editor:${randomUUID()}`;
        const counts = await Promise.all(Array.from({ length: 8 }, () => h.counter.hit(parallel, WINDOW)));
        expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      } finally {
        await h.close?.();
      }
    });
  });
}
