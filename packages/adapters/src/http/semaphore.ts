// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/** Releases a slot; calling it more than once has no further effect. */
export type Release = () => void;

interface Waiter {
  grant: (release: Release) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Counting semaphore with a bounded wait (CONN-6). FIFO among waiters. */
export class Semaphore {
  #limit: number;
  #inUse = 0;
  readonly #waiters: Waiter[] = [];

  constructor(limit: number) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  /** Changes the limit (configuration reload); waiters are admitted if the limit grew. */
  setLimit(limit: number): void {
    this.#limit = Math.max(1, Math.floor(limit));
    this.#drain();
  }

  /** Resolves with a release function, or with undefined when no slot frees up within `waitMs`. */
  acquire(waitMs: number): Promise<Release | undefined> {
    if (this.#inUse < this.#limit && this.#waiters.length === 0) return Promise.resolve(this.#take());
    if (waitMs <= 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        grant: resolve,
        timer: setTimeout(() => {
          const i = this.#waiters.indexOf(waiter);
          if (i >= 0) this.#waiters.splice(i, 1);
          resolve(undefined);
        }, waitMs),
      };
      this.#waiters.push(waiter);
    });
  }

  #take(): Release {
    this.#inUse += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inUse -= 1;
      this.#drain();
    };
  }

  #drain(): void {
    while (this.#inUse < this.#limit) {
      const next = this.#waiters.shift();
      if (!next) return;
      clearTimeout(next.timer);
      next.grant(this.#take());
    }
  }
}

const perConnection = new Map<string, Semaphore>();

/** The process-wide semaphore of a connection; a changed `max_concurrency` updates it in place. */
export function semaphoreFor(connectionId: string, limit: number): Semaphore {
  let s = perConnection.get(connectionId);
  if (!s) {
    s = new Semaphore(limit);
    perConnection.set(connectionId, s);
  } else {
    s.setLimit(limit);
  }
  return s;
}
