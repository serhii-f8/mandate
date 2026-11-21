// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * Opaque change-sets for worker tests (design phase 9 §5): a scripted `OpaqueCaller` that honours
 * the port's contract (pre-flight, `beforeSend`, one send) and counts what it sends, and a prepared
 * opaque change-set with its one `call` item.
 */
import {
  OPAQUE_TARGET_ID,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type OpaqueCaller,
  type OpaqueCallOutcome,
} from '@aiops/core';
import { createPrepared, type ExecuteOptions } from './changesets.js';
import { OPAQUE_OPERATION } from './configuration.js';

/** Sends counted across every caller that shares it (e.g. two workers in one test). */
export interface SendCounter {
  sends: number;
}

/**
 * Answers `outcome` for every call: `not_sent` without calling `beforeSend`; otherwise `beforeSend`
 * (a throw propagates and nothing is sent), then one counted send. `pauseSend` holds the next send
 * open after it was counted, as a request that has left while the worker dies.
 */
export class ScriptedOpaqueCaller implements OpaqueCaller {
  /** Every `call`, sent or not. */
  calls = 0;
  private pause: { reached: () => void; gate: Promise<void> } | undefined;

  constructor(
    readonly counter: SendCounter = { sends: 0 },
    public outcome: OpaqueCallOutcome = { kind: 'accepted' },
  ) {}

  get sends(): number {
    return this.counter.sends;
  }

  /** Holds the next send open, after `beforeSend` and the count, until `release()`. */
  pauseSend(): { reached: Promise<void>; release(): void } {
    let release: () => void = () => undefined; // replaced synchronously by the Promise executor
    let reach: () => void = () => undefined; // replaced synchronously by the Promise executor
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    this.pause = { reached: reach, gate };
    return { reached, release };
  }

  async call(input: Parameters<OpaqueCaller['call']>[0]): Promise<OpaqueCallOutcome> {
    this.calls += 1;
    if (this.outcome.kind === 'not_sent') return this.outcome;
    await input.beforeSend();
    this.counter.sends += 1;
    const pause = this.pause;
    if (pause !== undefined) {
      this.pause = undefined;
      pause.reached();
      await pause.gate;
    }
    return this.outcome;
  }
}

/** A prepared opaque change-set of `OPAQUE_OPERATION` with its one `call` item (or `executing` with `execute`). */
export function createPreparedOpaque(
  repository: ChangeSetRepository,
  opts: { readonly note?: string; readonly execute?: ExecuteOptions } = {},
): Promise<ChangeSetRecord> {
  const args = { note: opts.note ?? 'restock the blue mugs' };
  return createPrepared(repository, 1, {
    operation: OPAQUE_OPERATION,
    args,
    itemFor: () => ({ targetId: OPAQUE_TARGET_ID, status: 'pending', before: null, after: args }),
    ...(opts.execute === undefined ? {} : { execute: opts.execute }),
  });
}
