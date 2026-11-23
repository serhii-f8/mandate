// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { AuditEventInput, FileLink, FileStore, StagedFile } from '@mandate/core';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Row {
  file: StagedFile;
  content: Uint8Array | undefined;
}

interface Link {
  readonly changesetId: string;
  readonly links: readonly FileLink[];
  readonly status: () => { final: boolean; endedAt?: Date };
}

/** In-memory `FileStore` (CS-10). Every step is synchronous, so two `stage` calls at once are serialised. */
export class InMemoryFileStore implements FileStore {
  private readonly rows = new Map<string, Row>();
  private readonly linked: Link[] = [];

  stage(
    input: Parameters<FileStore['stage']>[0],
    // The in-memory store has no audit log: the event is accepted and dropped.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the port's parameter
    audit: AuditEventInput,
  ): Promise<{ ok: true; file: StagedFile } | { ok: false; code: 'quota_exceeded' }> {
    let count = 0;
    let bytes = 0;
    for (const { file, content } of this.rows.values()) {
      if (file.owner !== input.owner || content === undefined) continue;
      count += 1;
      bytes += file.size;
    }
    if (count + 1 > input.quota.count || bytes + input.content.byteLength > input.quota.bytes) {
      return Promise.resolve({ ok: false, code: 'quota_exceeded' });
    }
    const file: StagedFile = {
      id: input.id,
      owner: input.owner,
      ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
      name: input.name,
      mediaType: input.mediaType,
      size: input.content.byteLength,
      sha256: input.sha256,
      preview: input.preview,
      createdAt: input.createdAt,
    };
    this.rows.set(input.id, { file, content: new Uint8Array(input.content) });
    return Promise.resolve({ ok: true, file });
  }

  get(id: string): Promise<StagedFile | undefined> {
    return Promise.resolve(UUID.test(id) ? this.rows.get(id.toLowerCase())?.file : undefined);
  }

  ownedBy(owner: string, limit: number): Promise<readonly StagedFile[]> {
    const files = [...this.rows.values()]
      .filter((r) => r.file.owner === owner && r.content !== undefined)
      .map((r) => r.file)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : 1));
    return Promise.resolve(files.slice(0, limit));
  }

  content(id: string): Promise<Uint8Array | undefined> {
    const content = UUID.test(id) ? this.rows.get(id.toLowerCase())?.content : undefined;
    return Promise.resolve(content === undefined ? undefined : new Uint8Array(content));
  }

  ofChangeSet(changesetId: string): Promise<readonly { pointer: string; file: StagedFile }[]> {
    const out: { pointer: string; file: StagedFile }[] = [];
    for (const entry of this.linked) {
      if (entry.changesetId !== changesetId.toLowerCase()) continue;
      for (const link of entry.links) {
        const row = this.rows.get(link.fileId);
        if (row !== undefined) out.push({ pointer: link.pointer, file: row.file });
      }
    }
    return Promise.resolve(out.sort((a, b) => (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0)));
  }

  purge(
    input: { now: Date; stagedTtlHours: number; keepDays: number; limit: number },
    audit: (purged: number) => AuditEventInput,
  ): Promise<number> {
    const ttlCut = input.now.getTime() - input.stagedTtlHours * HOUR;
    const keepCut = input.now.getTime() - input.keepDays * DAY;
    const candidates = [...this.rows.values()]
      .filter((row) => row.content !== undefined && this.purgeable(row.file, ttlCut, keepCut))
      .sort((a, b) => a.file.createdAt.getTime() - b.file.createdAt.getTime())
      .slice(0, input.limit);
    for (const row of candidates) {
      row.content = undefined;
      row.file = { ...row.file, purgedAt: input.now };
    }
    if (candidates.length > 0) audit(candidates.length);
    return Promise.resolve(candidates.length);
  }

  private purgeable(file: StagedFile, ttlCut: number, keepCut: number): boolean {
    const using = this.linked.filter((entry) => entry.links.some((l) => l.fileId === file.id));
    if (using.length === 0) return file.createdAt.getTime() < ttlCut;
    let latest = Number.NEGATIVE_INFINITY;
    for (const entry of using) {
      const status = entry.status();
      if (!status.final) return false;
      latest = Math.max(latest, status.endedAt?.getTime() ?? Number.POSITIVE_INFINITY);
    }
    return latest < keepCut;
  }

  /** Test only: replaces the stored bytes without touching the sealed hash. */
  corrupt(id: string, content: Uint8Array): void {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error('unknown file');
    row.content = new Uint8Array(content);
  }

  /**
   * The creation check of the PostgreSQL store (`FOR SHARE`, own file with content): the pointer of the first
   * link whose file is unknown, not `owner`'s or purged, else undefined. Synchronous, so no purge runs between
   * this check and the `linkFor` call that follows it.
   */
  unavailable(owner: string, links: readonly FileLink[]): string | undefined {
    for (const link of links) {
      const row = UUID.test(link.fileId) ? this.rows.get(link.fileId.toLowerCase()) : undefined;
      if (row?.file.owner !== owner || row.content === undefined) return link.pointer;
    }
    return undefined;
  }

  /** Records that the change-set carries `links`; `status` says whether it is final and when it ended. */
  linkFor(changesetId: string, links: readonly FileLink[], status: () => { final: boolean; endedAt?: Date }): void {
    this.linked.push({ changesetId: changesetId.toLowerCase(), links: links.map((l) => ({ pointer: l.pointer, fileId: l.fileId.toLowerCase() })), status });
  }
}
