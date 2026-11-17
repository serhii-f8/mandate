import { and, asc, eq, gt, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type {
  AuditEventInput,
  AuditLog,
  ChangeItemRecord,
  ChangeSetRecord,
  ChangeSetRepository,
  ChangeSetStats,
  ChangeSetStatus,
  ExclusionReason,
  ItemOutcome,
  ItemsPageQuery,
  NewChangeSet,
} from '@aiops/core';
import { EMPTY_STATS } from '@aiops/core';
import { DrizzleAuditLog } from './audit-log.js';
import type { Db, DbExecutor } from './client.js';
import { changeItem, changeSet } from './schema.js';

const MAX_PAGE = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PostgresChangeSetRepositoryOptions {
  /** Audit log bound to the transaction of a state change. Tests wrap it to inject failures. */
  readonly auditFor?: (tx: DbExecutor) => AuditLog;
}

type ChangeSetRow = typeof changeSet.$inferSelect;
type ChangeItemRow = typeof changeItem.$inferSelect;

function toRecord(row: ChangeSetRow): ChangeSetRecord {
  return {
    id: row.id,
    operation: row.operation,
    connection: row.connection,
    requester: row.requester,
    ...(row.clientId === null ? {} : { clientId: row.clientId }),
    args: row.args,
    ...(row.hash === null ? {} : { hash: row.hash }),
    status: row.status,
    stats: row.stats,
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
    configHash: row.configHash,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    ...(row.preparedAt === null ? {} : { preparedAt: row.preparedAt }),
    expiresAt: row.expiresAt,
  };
}

function toItem(row: ChangeItemRow): ChangeItemRecord {
  return {
    targetId: row.targetId,
    status: row.status,
    ...(row.reason === null ? {} : { reason: row.reason }),
    before: row.before,
    after: row.after,
    ...(row.error === null ? {} : { error: row.error }),
  };
}

/** Postgres error code of `error` or of its cause (drizzle wraps driver errors). */
function pgCode(error: unknown): string | undefined {
  for (let e: unknown = error; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * PostgreSQL implementation of the core `ChangeSetRepository` port (CS-2, CS-4, CS-6, NFR-7).
 * Every state change and its audit event commit in one transaction. Immutability after
 * `prepared` is also enforced by the triggers of migration `0004_change_set_immutability`.
 * Error messages carry no argument values (SEC-3): drizzle's own errors quote parameters.
 */
export class PostgresChangeSetRepository implements ChangeSetRepository {
  private readonly auditFor: (tx: DbExecutor) => AuditLog;

  constructor(
    private readonly db: Db,
    options: PostgresChangeSetRepositoryOptions = {},
  ) {
    this.auditFor = options.auditFor ?? ((tx) => new DrizzleAuditLog(tx));
  }

  async create(cs: NewChangeSet, audit: AuditEventInput): Promise<ChangeSetRecord> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(changeSet)
          .values({
            id: cs.id,
            operation: cs.operation,
            connection: cs.connection,
            requester: cs.requester,
            clientId: cs.clientId ?? null,
            args: { ...cs.args },
            status: 'preparing',
            stats: EMPTY_STATS,
            configHash: cs.configHash,
            correlationId: cs.correlationId,
            createdAt: cs.createdAt,
            expiresAt: cs.expiresAt,
          })
          .returning();
        if (row === undefined) throw new Error('change-set insert returned no row');
        await this.auditFor(tx).append(audit);
        return toRecord(row);
      });
    } catch (error) {
      // No `cause`: drizzle's error quotes the statement parameters, the call arguments among them (SEC-3).
      // eslint-disable-next-line preserve-caught-error -- see above
      if (pgCode(error) === '23505') throw new Error('change-set already exists');
      // eslint-disable-next-line preserve-caught-error -- see above
      if (pgCode(error) !== undefined) throw new Error('change-set could not be created');
      throw error;
    }
  }

  async appendItems(changesetId: string, items: readonly ChangeItemRecord[]): Promise<number> {
    if (!UUID.test(changesetId)) throw new Error('unknown change-set');
    try {
      return await this.db.transaction(async (tx) => {
        // FOR SHARE: a concurrent status change waits until this append commits.
        const [parent] = await tx
          .select({ status: changeSet.status })
          .from(changeSet)
          .where(eq(changeSet.id, changesetId))
          .for('share');
        if (parent === undefined) throw new Error('unknown change-set');
        if (parent.status !== 'preparing') throw new Error('change-set is not preparing');
        // All-or-nothing: validate the whole batch before inserting anything.
        for (const it of items) {
          if (it.status !== 'pending' && it.status !== 'excluded') {
            throw new Error('item status is not allowed on append');
          }
        }
        // Duplicates by target keep the first copy, within the batch and against stored items.
        const seen = new Set<string>();
        const rows: Record<string, unknown>[] = [];
        for (const it of items) {
          if (seen.has(it.targetId)) continue;
          seen.add(it.targetId);
          rows.push({
            t: it.targetId,
            s: it.status,
            r: it.reason ?? null,
            b: it.before ?? null,
            a: it.after ?? null,
          });
        }
        if (rows.length === 0) return 0;
        const result = await tx.execute(sql`
          INSERT INTO change_item (changeset_id, target_id, status, reason, before, after)
          SELECT ${changesetId}::uuid, e->>'t', e->>'s', e->>'r', e->'b', e->'a'
          FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) WITH ORDINALITY AS x(e, ord)
          ORDER BY ord
          ON CONFLICT (changeset_id, target_id) DO NOTHING`);
        return result.rowCount ?? 0;
      });
    } catch (error) {
      // Trigger rejections and driver errors quote parameters; rethrow without them and
      // without `cause` (SEC-3).
      // eslint-disable-next-line preserve-caught-error -- see above
      if (pgCode(error) !== undefined) throw new Error('change items could not be appended');
      throw error;
    }
  }

  async stats(changesetId: string): Promise<ChangeSetStats> {
    if (!UUID.test(changesetId)) return structuredClone(EMPTY_STATS);
    return computeStats(this.db, changesetId);
  }

  async get(changesetId: string): Promise<ChangeSetRecord | undefined> {
    if (!UUID.test(changesetId)) return undefined;
    const [row] = await this.db.select().from(changeSet).where(eq(changeSet.id, changesetId));
    return row === undefined ? undefined : toRecord(row);
  }

  async itemsPage(changesetId: string, query: ItemsPageQuery): Promise<readonly ChangeItemRecord[]> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_PAGE) {
      throw new Error(`limit must be between 1 and ${MAX_PAGE}`);
    }
    if (!UUID.test(changesetId)) return [];
    const conditions: SQL[] = [eq(changeItem.changesetId, changesetId)];
    // Keyset on the primary key; the column's "C" collation orders by code point.
    if (query.after !== undefined) conditions.push(gt(changeItem.targetId, query.after));
    if (query.status !== undefined) conditions.push(eq(changeItem.status, query.status));
    const rows = await this.db
      .select()
      .from(changeItem)
      .where(and(...conditions))
      .orderBy(asc(changeItem.targetId))
      .limit(query.limit);
    return rows.map(toItem);
  }

  async completePreparation(
    changesetId: string,
    outcome:
      | { status: 'prepared'; hash: string; stats: ChangeSetStats; preparedAt: Date }
      | { status: 'failed'; errorCode: string },
    audit: AuditEventInput,
  ): Promise<ChangeSetRecord | undefined> {
    if (!UUID.test(changesetId)) return undefined;
    const set: PgUpdateSetSource<typeof changeSet> =
      outcome.status === 'prepared'
        ? {
            status: 'prepared' as const,
            hash: outcome.hash,
            stats: outcome.stats,
            preparedAt: outcome.preparedAt,
            updatedAt: sql`now()`,
          }
        : { status: 'failed' as const, errorCode: outcome.errorCode, updatedAt: sql`now()` };
    return this.compareAndSet(changesetId, ['preparing'], set, audit);
  }

  async transition(
    changesetId: string,
    from: readonly ChangeSetStatus[],
    to: ChangeSetStatus,
    audit: AuditEventInput,
    extra?: { errorCode?: string; expiredBefore?: Date },
  ): Promise<ChangeSetRecord | undefined> {
    if (!UUID.test(changesetId) || from.length === 0) return undefined;
    const set: PgUpdateSetSource<typeof changeSet> = {
      status: to,
      ...(extra?.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
      updatedAt: sql`now()`,
    };
    return this.compareAndSet(changesetId, from, set, audit, extra?.expiredBefore);
  }

  async recordItemOutcomes(changesetId: string, outcomes: readonly ItemOutcome[]): Promise<void> {
    if (!UUID.test(changesetId)) return;
    // The first outcome per target wins, as later ones would find the item no longer pending.
    const seen = new Set<string>();
    const rows: Record<string, unknown>[] = [];
    for (const o of outcomes) {
      if (seen.has(o.targetId)) continue;
      seen.add(o.targetId);
      rows.push({ target_id: o.targetId, status: o.status, error: o.error ?? null });
    }
    await this.db.transaction(async (tx) => {
      // Serializes outcome batches per change-set so the recomputed stats see every batch.
      const [parent] = await tx
        .select({ id: changeSet.id })
        .from(changeSet)
        .where(eq(changeSet.id, changesetId))
        .for('update');
      if (parent === undefined) return;
      if (rows.length > 0) {
        await tx.execute(sql`
          UPDATE change_item AS ci
          SET status = o.status, error = COALESCE(o.error, ci.error), updated_at = now()
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS o(target_id text, status text, error text)
          WHERE ci.changeset_id = ${changesetId}::uuid
            AND ci.target_id = o.target_id
            AND ci.status = 'pending'`);
      }
      const stats = await computeStats(tx, changesetId);
      await tx.update(changeSet).set({ stats, updatedAt: sql`now()` }).where(eq(changeSet.id, changesetId));
    });
  }

  /** Compare-and-set on status; no matching row writes no audit event and returns undefined. */
  private async compareAndSet(
    changesetId: string,
    from: readonly ChangeSetStatus[],
    set: PgUpdateSetSource<typeof changeSet>,
    audit: AuditEventInput,
    expiredBefore?: Date,
  ): Promise<ChangeSetRecord | undefined> {
    return this.db.transaction(async (tx) => {
      const conditions: SQL[] = [eq(changeSet.id, changesetId), inArray(changeSet.status, [...from])];
      if (expiredBefore !== undefined) conditions.push(lte(changeSet.expiresAt, expiredBefore));
      const [row] = await tx
        .update(changeSet)
        .set(set)
        .where(and(...conditions))
        .returning();
      if (row === undefined) return undefined;
      await this.auditFor(tx).append(audit);
      return toRecord(row);
    });
  }
}

async function computeStats(db: Db | DbExecutor, changesetId: string): Promise<ChangeSetStats> {
  const rows = await db
    .select({ status: changeItem.status, reason: changeItem.reason, n: sql<number>`count(*)::int` })
    .from(changeItem)
    .where(eq(changeItem.changesetId, changesetId))
    .groupBy(changeItem.status, changeItem.reason);
  const excluded: Partial<Record<ExclusionReason, number>> = {};
  let total = 0;
  let included = 0;
  let written = 0;
  let failed = 0;
  let skipped = 0;
  for (const { status, reason, n } of rows) {
    total += n;
    if (status === 'excluded') {
      if (reason !== null) excluded[reason] = (excluded[reason] ?? 0) + n;
      continue;
    }
    included += n;
    if (status === 'written') written += n;
    else if (status === 'failed') failed += n;
    else if (status === 'skipped') skipped += n;
  }
  return { total, included, excluded, written, failed, skipped };
}
