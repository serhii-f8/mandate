import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuditAction, AuditEventInput, ConfigRevisionStore, NewConfigRevision } from '@aiops/core';

/** One fresh, empty store per call. `auditRows` reads the audit events the store appended. */
export interface ConfigRevisionStoreHarness {
  readonly store: ConfigRevisionStore;
  readonly auditRows: () => Promise<readonly AuditEventInput[]>;
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

const SUMMARY = { connections: 1, operations: 2, roles: 3, notifications: 0 } as const;

function revision(hash: string, actor = 'cli:alice'): NewConfigRevision {
  return { id: randomUUID(), hash, files: { 'config.yaml': `hash: ${hash}\n` }, actor, summary: SUMMARY };
}

function bootstrapRevision(hash: string): Omit<NewConfigRevision, 'actor'> {
  const { id, files, summary } = revision(hash);
  return { id, hash, files, summary };
}

function auditEvent(action: AuditAction): AuditEventInput {
  return { id: randomUUID(), actor: 'cli:alice', action, outcome: 'ok', correlationId: randomUUID(), details: { note: 'contract' } };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached within 10 s');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Behaviour every ConfigRevisionStore implementation must have (CFG-4, CFG-3). */
export function describeConfigRevisionStoreContract(make: () => Promise<ConfigRevisionStoreHarness>): void {
  describe('CFG-4 configuration revision store', () => {
    it('CFG-4 active is undefined on an empty store', async () => {
      const { store } = await make();
      expect(await store.active()).toBeUndefined();
      expect(await store.activeSeq()).toBeUndefined();
    });

    it('CFG-4 bootstrap inserts once with source bootstrap and actor system, then returns the existing revision', async () => {
      const { store, auditRows } = await make();
      const first = await store.bootstrap(bootstrapRevision(HASH_A));
      expect(first.seq).toBeGreaterThanOrEqual(1);
      expect(first.source).toBe('bootstrap');
      expect(first.actor).toBe('system');
      expect(first.hash).toBe(HASH_A);
      expect(first.appliedAt).toBeInstanceOf(Date);

      const second = await store.bootstrap(bootstrapRevision(HASH_B));
      expect(second.id).toBe(first.id);
      expect(second.hash).toBe(HASH_A);
      expect(await store.active()).toEqual(first);
      expect(await auditRows()).toEqual([]);
    });

    it('CFG-4 activeSeq is the seq of the active revision', async () => {
      const { store } = await make();
      const a = await store.bootstrap(bootstrapRevision(HASH_A));
      expect(await store.activeSeq()).toBe(a.seq);
      const b = await store.apply(revision(HASH_B), auditEvent('config.apply'), HASH_A);
      if (!b.ok) throw new Error(`apply refused: ${b.reason}`);
      expect(await store.activeSeq()).toBe(b.revision.seq);
    });

    it('CFG-4 apply inserts a newer revision with its audit row', async () => {
      const { store, auditRows } = await make();
      const a = await store.bootstrap(bootstrapRevision(HASH_A));
      const b = revision(HASH_B);
      const event = auditEvent('config.apply');
      const result = await store.apply(b, event, HASH_A);
      if (!result.ok) throw new Error(`apply refused: ${result.reason}`);
      expect(result.revision).toMatchObject({ id: b.id, hash: HASH_B, actor: 'cli:alice', source: 'apply' });
      expect(result.revision.seq).toBeGreaterThan(a.seq);
      expect(await store.active()).toEqual(result.revision);
      const rows = await auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: event.id, action: 'config.apply', actor: 'cli:alice', outcome: 'ok' });
    });

    it('CFG-4 apply refuses concurrent_apply when the active hash is not the expected one, and writes nothing', async () => {
      const { store, auditRows } = await make();
      const a = await store.bootstrap(bootstrapRevision(HASH_A));
      expect(await store.apply(revision(HASH_C), auditEvent('config.apply'), HASH_B)).toEqual({ ok: false, reason: 'concurrent_apply' });
      expect(await store.apply(revision(HASH_C), auditEvent('config.apply'), null)).toEqual({ ok: false, reason: 'concurrent_apply' });
      expect(await store.active()).toEqual(a);
      expect(await auditRows()).toEqual([]);

      // Two applies diffed against the same active hash: exactly one wins.
      const results = await Promise.all([
        store.apply(revision(HASH_B), auditEvent('config.apply'), HASH_A),
        store.apply(revision(HASH_C), auditEvent('config.apply'), HASH_A),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'concurrent_apply' }]);
      expect(await auditRows()).toHaveLength(1);
    });

    it('CFG-4 apply refuses unchanged when the new hash is the active one, and writes nothing', async () => {
      const { store, auditRows } = await make();
      const a = await store.bootstrap(bootstrapRevision(HASH_A));
      expect(await store.apply(revision(HASH_A), auditEvent('config.apply'), HASH_A)).toEqual({ ok: false, reason: 'unchanged' });
      expect(await store.active()).toEqual(a);
      expect(await auditRows()).toEqual([]);
    });

    it('CFG-4 apply on an empty store expects null', async () => {
      const refused = await make();
      expect(await refused.store.apply(revision(HASH_A), auditEvent('config.apply'), HASH_A)).toEqual({ ok: false, reason: 'concurrent_apply' });
      expect(await refused.store.active()).toBeUndefined();
      expect(await refused.auditRows()).toEqual([]);

      const { store, auditRows } = await make();
      const result = await store.apply(revision(HASH_A), auditEvent('config.apply'), null);
      if (!result.ok) throw new Error(`apply refused: ${result.reason}`);
      expect(result.revision.source).toBe('apply');
      expect(await store.active()).toEqual(result.revision);
      expect(await auditRows()).toHaveLength(1);
    });

    it('CFG-4 files and summary round-trip', async () => {
      const { store } = await make();
      const files = { 'roles.yaml': 'roles:\n  editor: {}\n', 'specs/shop.json': '{"openapi":"3.0.0"}\n' };
      const result = await store.apply({ ...revision(HASH_A), files, summary: { connections: 1, operations: 2, roles: 3, notifications: 0 } }, auditEvent('config.apply'), null);
      if (!result.ok) throw new Error(`apply refused: ${result.reason}`);
      expect(result.revision.files).toEqual(files);
      expect(result.revision.summary).toEqual({ connections: 1, operations: 2, roles: 3, notifications: 0 });
      const active = await store.active();
      expect(active?.files).toEqual(files);
      expect(active?.summary).toEqual({ connections: 1, operations: 2, roles: 3, notifications: 0 });
    });

    it('CFG-3 a listener is told about each apply once', async () => {
      const { store } = await make();
      let changes = 0;
      const listener = await store.listen({ onChange: () => { changes += 1; }, onReconnect: () => undefined, onError: () => undefined });
      try {
        const first = await store.apply(revision(HASH_A), auditEvent('config.apply'), null);
        expect(first.ok).toBe(true);
        // Barrier: notifications arrive in commit order, so once the second apply is heard a
        // duplicate of the first would already have been counted.
        const second = await store.apply(revision(HASH_B), auditEvent('config.apply'), HASH_A);
        expect(second.ok).toBe(true);
        await waitFor(() => changes >= 2);
        expect(changes).toBe(2);
      } finally {
        await listener.close();
      }
    });
  });
}
