// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Of, type AuditEventInput, type FileLink, type FileStore } from '@mandate/core';

export interface FileStoreHarness {
  readonly store: FileStore;
  /** Creates a change-set (not final) that links the files at their pointers. */
  link(changesetId: string, links: readonly FileLink[]): Promise<void>;
  /** Moves the change-set to a final status, last updated at `at`. */
  endChangeSet(changesetId: string, at: Date): Promise<void>;
}

const T0 = new Date('2026-03-01T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BIG_QUOTA = { count: 1000, bytes: 1_000_000 };

function audit(): { event: AuditEventInput; calls: number[]; callback: (n: number) => AuditEventInput } {
  const calls: number[] = [];
  const event = (n: number): AuditEventInput => ({
    id: randomUUID(),
    actor: 'system',
    action: 'files.purged',
    outcome: 'ok',
    correlationId: randomUUID(),
    details: { purged: n },
  });
  return {
    event: { ...event(0), action: 'file.staged', actor: 'alice' },
    calls,
    callback: (n) => {
      calls.push(n);
      return event(n);
    },
  };
}

/** Behavior every FileStore implementation must have (CS-10). A harness may share one database: owners are fresh per case. */
export function fileStoreContract(make: () => Promise<FileStoreHarness>): void {
  describe('CS-10 file store', () => {
    async function stage(
      h: FileStoreHarness,
      owner: string,
      content: string,
      options: { createdAt?: Date; quota?: { count: number; bytes: number }; name?: string } = {},
    ) {
      const bytes = new TextEncoder().encode(content);
      const id = randomUUID();
      const result = await h.store.stage(
        {
          id,
          owner,
          clientId: 'client-1',
          name: options.name ?? 'a.txt',
          mediaType: 'text/plain',
          content: bytes,
          sha256: sha256Of(bytes),
          preview: 'text',
          createdAt: options.createdAt ?? T0,
          quota: options.quota ?? BIG_QUOTA,
        },
        audit().event,
      );
      return { id, result, bytes };
    }

    it('CS-10 stage then get, content and ownedBy return the same metadata and bytes', async () => {
      const h = await make();
      const owner = `o-${randomUUID()}`;
      const { id, result, bytes } = await stage(h, owner, 'hello');
      expect(result.ok).toBe(true);
      const file = await h.store.get(id);
      expect(file).toMatchObject({
        id,
        owner,
        clientId: 'client-1',
        name: 'a.txt',
        mediaType: 'text/plain',
        size: 5,
        sha256: sha256Of(bytes),
        preview: 'text',
      });
      expect(file?.createdAt.getTime()).toBe(T0.getTime());
      expect(file?.purgedAt).toBeUndefined();
      expect(result.ok && result.file).toEqual(file);
      expect(Array.from((await h.store.content(id)) ?? [])).toEqual(Array.from(bytes));
      expect(await h.store.ownedBy(owner, 10)).toEqual([file]);
      expect(await h.store.get('nope')).toBeUndefined();
      expect(await h.store.content('nope')).toBeUndefined();
      expect(await h.store.get(randomUUID())).toBeUndefined();
      expect(await h.store.content(randomUUID())).toBeUndefined();
    });

    it('CS-10 ownedBy is newest first, limited, and excludes other owners', async () => {
      const h = await make();
      const owner = `o-${randomUUID()}`;
      const a = await stage(h, owner, 'a', { createdAt: new Date(T0.getTime() + 1000) });
      const b = await stage(h, owner, 'b', { createdAt: new Date(T0.getTime() + 3000) });
      const c = await stage(h, owner, 'c', { createdAt: new Date(T0.getTime() + 2000) });
      await stage(h, `o-${randomUUID()}`, 'other');
      expect((await h.store.ownedBy(owner, 10)).map((f) => f.id)).toEqual([b.id, c.id, a.id]);
      expect((await h.store.ownedBy(owner, 2)).map((f) => f.id)).toEqual([b.id, c.id]);
    });

    it('CS-10 the per-owner quota counts files and bytes, and purged files do not count', async () => {
      const h = await make();
      const owner = `o-${randomUUID()}`;
      const quota = { count: 2, bytes: 100 };
      expect((await stage(h, owner, 'x'.repeat(40), { quota })).result.ok).toBe(true);
      expect((await stage(h, owner, 'y'.repeat(40), { quota })).result.ok).toBe(true);
      expect((await stage(h, owner, 'z', { quota })).result).toEqual({ ok: false, code: 'quota_exceeded' });
      const byteOwner = `o-${randomUUID()}`;
      expect((await stage(h, byteOwner, 'x'.repeat(60), { quota })).result.ok).toBe(true);
      expect((await stage(h, byteOwner, 'y'.repeat(41), { quota })).result).toEqual({ ok: false, code: 'quota_exceeded' });
      expect((await stage(h, byteOwner, 'y'.repeat(40), { quota })).result.ok).toBe(true);
      // Purging frees the quota.
      const purgeOwner = `o-${randomUUID()}`;
      const first = await stage(h, purgeOwner, 'old', { quota: { count: 1, bytes: 100 }, createdAt: new Date(T0.getTime() - 48 * HOUR) });
      expect(first.result.ok).toBe(true);
      expect((await stage(h, purgeOwner, 'new', { quota: { count: 1, bytes: 100 } })).result.ok).toBe(false);
      await h.store.purge({ now: T0, stagedTtlHours: 24, keepDays: 7, limit: 1000 }, audit().callback);
      expect((await stage(h, purgeOwner, 'new', { quota: { count: 1, bytes: 100 } })).result.ok).toBe(true);
    });

    it('CS-10 two stage calls at once at count 1 store exactly one', async () => {
      const h = await make();
      const owner = `o-${randomUUID()}`;
      const quota = { count: 1, bytes: 1000 };
      const results = await Promise.all([stage(h, owner, 'one', { quota }), stage(h, owner, 'two', { quota })]);
      expect(results.filter((r) => r.result.ok)).toHaveLength(1);
      expect(await h.store.ownedBy(owner, 10)).toHaveLength(1);
    });

    it('CS-10 purge removes the content of an unreferenced file older than the TTL and keeps a younger one', async () => {
      const h = await make();
      const owner = `o-${randomUUID()}`;
      const old = await stage(h, owner, 'old', { createdAt: new Date(T0.getTime() - 25 * HOUR) });
      const young = await stage(h, owner, 'young', { createdAt: new Date(T0.getTime() - 23 * HOUR) });
      const a = audit();
      const purged = await h.store.purge({ now: T0, stagedTtlHours: 24, keepDays: 7, limit: 1000 }, a.callback);
      expect(purged).toBeGreaterThanOrEqual(1);
      expect(await h.store.content(old.id)).toBeUndefined();
      expect((await h.store.get(old.id))?.purgedAt).toBeInstanceOf(Date);
      expect((await h.store.ownedBy(owner, 10)).map((f) => f.id)).toEqual([young.id]);
      expect(await h.store.content(young.id)).toBeDefined();
    });

    it('CS-10 purge keeps a referenced file while its change-set is not final or ended less than keep_days ago', async () => {
      const h = await make();
      const owner = `o-${randomUUID()}`;
      const file = await stage(h, owner, 'doc', { createdAt: new Date(T0.getTime() - 100 * DAY) });
      const cs = randomUUID();
      await h.link(cs, [{ pointer: '/file', fileId: file.id }]);
      const run = () => h.store.purge({ now: T0, stagedTtlHours: 24, keepDays: 7, limit: 1000 }, audit().callback);
      await run();
      expect(await h.store.content(file.id)).toBeDefined();
      await h.endChangeSet(cs, new Date(T0.getTime() - 6 * DAY));
      await run();
      expect(await h.store.content(file.id)).toBeDefined();
      await h.endChangeSet(cs, new Date(T0.getTime() - 8 * DAY));
      await run();
      expect(await h.store.content(file.id)).toBeUndefined();
    });

    it('CS-10 a file used by two change-sets stays until both qualify', async () => {
      const h = await make();
      const owner = `o-${randomUUID()}`;
      const file = await stage(h, owner, 'shared', { createdAt: new Date(T0.getTime() - 100 * DAY) });
      const one = randomUUID();
      const two = randomUUID();
      await h.link(one, [{ pointer: '/file', fileId: file.id }]);
      await h.link(two, [{ pointer: '/file', fileId: file.id }]);
      const run = () => h.store.purge({ now: T0, stagedTtlHours: 24, keepDays: 7, limit: 1000 }, audit().callback);
      await h.endChangeSet(one, new Date(T0.getTime() - 30 * DAY));
      await run();
      expect(await h.store.content(file.id)).toBeDefined();
      await h.endChangeSet(two, new Date(T0.getTime() - 3 * DAY));
      await run();
      expect(await h.store.content(file.id)).toBeDefined();
      await h.endChangeSet(two, new Date(T0.getTime() - 9 * DAY));
      await run();
      expect(await h.store.content(file.id)).toBeUndefined();
    });

    it('CS-10 purge returns the count, respects the limit and audits once, and not at all for nothing', async () => {
      const h = await make();
      const owner = `o-${randomUUID()}`;
      // Isolate from other cases of a shared database: far in the past, purge everything first.
      const far = new Date(T0.getTime() + 1000 * DAY);
      await h.store.purge({ now: far, stagedTtlHours: 24, keepDays: 7, limit: 100_000 }, audit().callback);
      const created = new Date(far.getTime() - 48 * HOUR);
      for (const n of ['1', '2', '3']) await stage(h, owner, n, { createdAt: created });
      const a = audit();
      expect(await h.store.purge({ now: far, stagedTtlHours: 24, keepDays: 7, limit: 2 }, a.callback)).toBe(2);
      expect(a.calls).toEqual([2]);
      expect(await h.store.purge({ now: far, stagedTtlHours: 24, keepDays: 7, limit: 2 }, a.callback)).toBe(1);
      expect(a.calls).toEqual([2, 1]);
      expect(await h.store.purge({ now: far, stagedTtlHours: 24, keepDays: 7, limit: 2 }, a.callback)).toBe(0);
      expect(a.calls).toEqual([2, 1]);
    });

    it('CS-10 ofChangeSet is ordered by pointer and empty for an unknown or malformed ID', async () => {
      const h = await make();
      const owner = `o-${randomUUID()}`;
      const a = await stage(h, owner, 'a');
      const b = await stage(h, owner, 'b');
      const cs = randomUUID();
      await h.link(cs, [
        { pointer: '/z', fileId: a.id },
        { pointer: '/a/0', fileId: b.id },
      ]);
      const linked = await h.store.ofChangeSet(cs);
      expect(linked.map((l) => [l.pointer, l.file.id])).toEqual([
        ['/a/0', b.id],
        ['/z', a.id],
      ]);
      expect(await h.store.ofChangeSet(randomUUID())).toEqual([]);
      expect(await h.store.ofChangeSet('not-a-uuid')).toEqual([]);
    });
  });
}
