// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Spaces the requests of one connection at least `minIntervalMs` apart (CONN-6). Slots are booked
 * in arrival order; the booking is synchronous, so callers that arrive together get distinct
 * slots. `holdUntil` pushes the next slot back (an honoured `Retry-After`) and never forward.
 */
export class Pacer {
  #interval: number;
  #next = 0;

  constructor(minIntervalMs: number) {
    this.#interval = Math.max(0, minIntervalMs);
  }

  /** Changes the interval (configuration reload); slots already booked stay. */
  setInterval(minIntervalMs: number): void {
    this.#interval = Math.max(0, minIntervalMs);
  }

  /**
   * Books the next slot and returns the milliseconds to wait before sending, or undefined, with
   * nothing booked, when the wait would exceed `maxWaitMs`.
   */
  reserve(now: number, maxWaitMs: number): number | undefined {
    const start = Math.max(now, this.#next);
    if (start - now > maxWaitMs) return undefined;
    this.#next = start + this.#interval;
    return start - now;
  }

  /** No request starts before `at` (epoch milliseconds, as `now` of `reserve`). */
  holdUntil(at: number): void {
    if (at > this.#next) this.#next = at;
  }
}

const perConnection = new Map<string, Pacer>();

/**
 * The process-wide pacer of a connection; a changed interval updates it in place. Without an
 * interval the pacer still carries a `Retry-After` hold. The state is per process (ADR 0064).
 */
export function pacerFor(connectionId: string, minIntervalMs: number | undefined): Pacer {
  let p = perConnection.get(connectionId);
  if (!p) {
    p = new Pacer(minIntervalMs ?? 0);
    perConnection.set(connectionId, p);
  } else {
    p.setInterval(minIntervalMs ?? 0);
  }
  return p;
}

/** Test hook: forgets every pacer. */
export function clearPacers(): void {
  perConnection.clear();
}
