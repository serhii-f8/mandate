// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { AuditEventInput, FileStore, StagedFile } from '@mandate/core';
import { DrizzleAuditLog } from './audit-log.js';
import type { Db } from './client.js';
import { guarded } from './errors.js';
import { FILE_STAGE_LOCK_NAMESPACE } from './locks.js';
import { changeSetFile, stagedFile } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses after which a change-set no longer needs its files (spec 4.2 "Lifetime"). */
const FINAL_STATUSES = sql`('completed', 'completed_with_errors', 'failed', 'rejected', 'expired', 'cancelled', 'rolled_back')`;

type Row = typeof stagedFile.$inferSelect;

function toFile(row: Omit<Row, 'content'>): StagedFile {
  return {
    id: row.id,
    owner: row.owner,
    ...(row.clientId === null ? {} : { clientId: row.clientId }),
    name: row.name,
    mediaType: row.mediaType,
    size: row.size,
    sha256: row.sha256,
    preview: row.preview,
    createdAt: row.createdAt,
    ...(row.purgedAt === null ? {} : { purgedAt: row.purgedAt }),
  };
}

const META = {
  id: stagedFile.id,
  owner: stagedFile.owner,
  clientId: stagedFile.clientId,
  name: stagedFile.name,
  mediaType: stagedFile.mediaType,
  size: stagedFile.size,
  sha256: stagedFile.sha256,
  preview: stagedFile.preview,
  createdAt: stagedFile.createdAt,
  purgedAt: stagedFile.purgedAt,
};

/** Test seams of `PostgresFileStore`. Production code passes none. */
export interface PostgresFileStoreSeams {
  /**
   * Test only: receives the IDs the purge's candidate read chose and returns the IDs its UPDATE works on. It
   * stands in for a candidate read that chose a file on a stale snapshot, which no test can time (CS-10).
   */
  readonly purgeCandidates?: (ids: readonly string[]) => readonly string[];
}

/**
 * PostgreSQL implementation of the core `FileStore` port (CS-10). `stage` and `purge` append their audit
 * event on the same transaction as the write. Errors carry codes only: file names and content never
 * reach a message (SEC-3).
 */
export class PostgresFileStore implements FileStore {
  constructor(
    private readonly db: Db,
    private readonly seams: PostgresFileStoreSeams = {},
  ) {}

  async stage(
    input: Parameters<FileStore['stage']>[0],
    audit: AuditEventInput,
  ): Promise<{ ok: true; file: StagedFile } | { ok: false; code: 'quota_exceeded' }> {
    return guarded('file stage', () =>
      this.db.transaction(async (tx) => {
        // Serialises uploads of one owner: the count below sees every committed earlier upload.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${FILE_STAGE_LOCK_NAMESPACE}::int4, hashtext(${input.owner}))`);
        const [usage] = await tx
          .select({
            count: sql<number>`count(*)::int`,
            bytes: sql<string>`coalesce(sum(${stagedFile.size}), 0)::text`,
          })
          .from(stagedFile)
          .where(and(eq(stagedFile.owner, input.owner), isNotNull(stagedFile.content)));
        const count = usage?.count ?? 0;
        const bytes = Number(usage?.bytes ?? '0');
        if (count + 1 > input.quota.count || bytes + input.content.byteLength > input.quota.bytes) {
          return { ok: false as const, code: 'quota_exceeded' as const };
        }
        const [row] = await tx
          .insert(stagedFile)
          .values({
            id: input.id,
            owner: input.owner,
            clientId: input.clientId ?? null,
            name: input.name,
            mediaType: input.mediaType,
            size: input.content.byteLength,
            sha256: input.sha256,
            preview: input.preview,
            content: Buffer.from(input.content),
            createdAt: input.createdAt,
          })
          .returning(META);
        if (row === undefined) throw new Error('staged file insert returned no row');
        await new DrizzleAuditLog(tx).append(audit);
        return { ok: true as const, file: toFile(row) };
      }),
    );
  }

  async get(id: string): Promise<StagedFile | undefined> {
    if (!UUID.test(id)) return undefined;
    const [row] = await guarded('file read', () => this.db.select(META).from(stagedFile).where(eq(stagedFile.id, id)));
    return row === undefined ? undefined : toFile(row);
  }

  async ownedBy(owner: string, limit: number): Promise<readonly StagedFile[]> {
    const rows = await guarded('file list', () =>
      this.db
        .select(META)
        .from(stagedFile)
        .where(and(eq(stagedFile.owner, owner), isNotNull(stagedFile.content)))
        .orderBy(desc(stagedFile.createdAt), asc(stagedFile.id))
        .limit(limit),
    );
    return rows.map(toFile);
  }

  async content(id: string): Promise<Uint8Array | undefined> {
    if (!UUID.test(id)) return undefined;
    const [row] = await guarded('file content', () =>
      this.db.select({ content: stagedFile.content }).from(stagedFile).where(eq(stagedFile.id, id)),
    );
    return row?.content ?? undefined;
  }

  async ofChangeSet(changesetId: string): Promise<readonly { pointer: string; file: StagedFile }[]> {
    if (!UUID.test(changesetId)) return [];
    const rows = await guarded('file links', () =>
      this.db
        .select({ pointer: changeSetFile.pointer, ...META })
        .from(changeSetFile)
        .innerJoin(stagedFile, eq(stagedFile.id, changeSetFile.fileId))
        .where(eq(changeSetFile.changeSetId, changesetId))
        // Code-point order, like the pointers of the manifest.
        .orderBy(sql`${changeSetFile.pointer} COLLATE "C"`),
    );
    return rows.map(({ pointer, ...file }) => ({ pointer, file: toFile(file) }));
  }

  async purge(
    input: { now: Date; stagedTtlHours: number; keepDays: number; limit: number },
    audit: (purged: number) => AuditEventInput,
  ): Promise<number> {
    const ttlCut = new Date(input.now.getTime() - input.stagedTtlHours * 3_600_000);
    const keepCut = new Date(input.now.getTime() - input.keepDays * 86_400_000);
    // The condition is evaluated twice, and both evaluations are needed (CS-10):
    // 1. The candidate read locks the rows it chooses, skipping rows another transaction holds. It evaluates
    //    the condition on its own snapshot. A creation that links a file and commits after that snapshot was
    //    taken but before the read reaches the row has released its FOR SHARE lock, so the row is not skipped;
    //    the creation locked the row without updating it, so PostgreSQL does not re-evaluate the condition on
    //    a newer version either. The read then chooses a file that is linked to a live change-set.
    // 2. The UPDATE is a new statement with a new snapshot (READ COMMITTED) and sees that link, so `AND
    //    eligible` drops the file. This re-check closes the "creation committed after the candidate snapshot"
    //    window and must not be removed.
    // The other ordering is closed on the creation side: `ChangeSetRepository.create` locks the file rows FOR
    // SHARE and re-checks `purged_at IS NULL` in that locked read, so a creation that waits for this purge
    // refuses the purged file.
    const eligible = sql`
      f.content IS NOT NULL AND (
        (NOT EXISTS (SELECT 1 FROM change_set_file l WHERE l.file_id = f.id) AND f.created_at < ${ttlCut})
        OR (
          EXISTS (SELECT 1 FROM change_set_file l WHERE l.file_id = f.id)
          AND NOT EXISTS (
            SELECT 1 FROM change_set_file l JOIN change_set c ON c.id = l.change_set_id
            WHERE l.file_id = f.id AND c.status NOT IN ${FINAL_STATUSES})
          AND (SELECT max(c.updated_at) FROM change_set_file l JOIN change_set c ON c.id = l.change_set_id
               WHERE l.file_id = f.id) < ${keepCut}
        )
      )`;
    return guarded('file purge', () =>
      this.db.transaction(async (tx) => {
        const candidates = await tx.execute<{ id: string }>(sql`
          SELECT f.id FROM staged_file f WHERE ${eligible}
          ORDER BY f.created_at, f.id LIMIT ${input.limit} FOR UPDATE OF f SKIP LOCKED`);
        const chosen = candidates.rows.map((r) => r.id);
        const ids = this.seams.purgeCandidates?.(chosen) ?? chosen;
        if (ids.length === 0) return 0;
        const updated = await tx.execute(sql`
          UPDATE staged_file f SET content = NULL, purged_at = ${input.now}
          WHERE f.id = ANY(${`{${ids.join(',')}}`}::uuid[]) AND ${eligible}`);
        const purged = updated.rowCount ?? 0;
        if (purged > 0) await new DrizzleAuditLog(tx).append(audit(purged));
        return purged;
      }),
    );
  }
}
