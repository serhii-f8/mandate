// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type {
  ApplyRevisionResult,
  AuditEventInput,
  ConfigListener,
  ConfigListenerHandlers,
  ConfigRevision,
  ConfigRevisionStore,
  NewConfigRevision,
} from '@mandate/core';
import type { InMemoryAuditLog } from './in-memory-audit-log.js';

/**
 * Configuration revision store fake (CFG-4). `bootstrap` and `apply` run one after another on a
 * promise chain, as the PostgreSQL advisory lock serialises them. `apply` appends its audit event
 * first, so a failing append writes no revision; listeners hear a successful apply synchronously.
 */
export class InMemoryConfigRevisionStore implements ConfigRevisionStore {
  private readonly revisions: ConfigRevision[] = [];
  private readonly listeners = new Set<ConfigListenerHandlers>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly audit: InMemoryAuditLog) {}

  active(): Promise<ConfigRevision | undefined> {
    return Promise.resolve(this.revisions.at(-1));
  }

  activeSeq(): Promise<number | undefined> {
    return Promise.resolve(this.revisions.at(-1)?.seq);
  }

  bootstrap(revision: Omit<NewConfigRevision, 'actor'>): Promise<ConfigRevision> {
    return this.serial(() => {
      const existing = this.revisions.at(-1);
      if (existing !== undefined) return Promise.resolve(existing);
      return Promise.resolve(this.insert({ ...revision, actor: 'system' }, 'bootstrap'));
    });
  }

  apply(revision: NewConfigRevision, audit: AuditEventInput, expectedPreviousHash: string | null): Promise<ApplyRevisionResult> {
    return this.serial(async (): Promise<ApplyRevisionResult> => {
      const activeHash = this.revisions.at(-1)?.hash ?? null;
      if (activeHash !== expectedPreviousHash) return { ok: false, reason: 'concurrent_apply' };
      if (activeHash === revision.hash) return { ok: false, reason: 'unchanged' };
      await this.audit.append(audit);
      const stored = this.insert(revision, 'apply');
      for (const handlers of [...this.listeners]) handlers.onChange();
      return { ok: true, revision: stored };
    });
  }

  listen(handlers: ConfigListenerHandlers): Promise<ConfigListener> {
    this.listeners.add(handlers);
    return Promise.resolve({
      close: () => {
        this.listeners.delete(handlers);
        return Promise.resolve();
      },
    });
  }

  /** Test hook: every open listener is told the connection came back. */
  emitReconnect(): void {
    for (const handlers of [...this.listeners]) handlers.onReconnect();
  }

  private insert(revision: NewConfigRevision, source: ConfigRevision['source']): ConfigRevision {
    const stored: ConfigRevision = Object.freeze({
      id: revision.id,
      hash: revision.hash,
      files: Object.freeze({ ...revision.files }),
      actor: revision.actor,
      summary: Object.freeze({ ...revision.summary }),
      seq: (this.revisions.at(-1)?.seq ?? 0) + 1,
      source,
      appliedAt: new Date(),
    });
    this.revisions.push(stored);
    return stored;
  }

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
