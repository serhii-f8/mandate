// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { RateCounter } from '@mandate/core';

/** In-memory fixed-window counter (POL-4 calls_per_minute). The increment is synchronous, so parallel hits get distinct counts. */
export class InMemoryRateCounter implements RateCounter {
  private readonly counts = new Map<string, number>();

  hit(key: string, windowStart: Date): Promise<number> {
    const bucket = `${String(windowStart.getTime())}\u0000${key}`;
    const count = (this.counts.get(bucket) ?? 0) + 1;
    this.counts.set(bucket, count);
    return Promise.resolve(count);
  }
}
