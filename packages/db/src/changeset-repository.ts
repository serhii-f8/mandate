import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type {
  ApprovalRecord,
  AuditEventInput,
  AuditLog,
  BatchCounts,
  BatchRecord,
  BatchSubmission,
  CancelRequest,
  ChangeItemRecord,
  ChangeSetRecord,
  ChangeSetRepository,
  ChangeSetStats,
  ChangeSetStatus,
  ExclusionReason,
  ExecutionUsage,
  ItemOutcome,
  ItemsPageQuery,
  NewChangeSet,
  Submission,
} from '@aiops/core';
import { changesetTransitionEvent, EMPTY_STATS, evaluateLimits, isExpiryDue } from '@aiops/core';
import { DrizzleAuditLog } from './audit-log.js';
import { guarded, pgCode } from './errors.js';
import type { Db, DbExecutor } from './client.js';
import { approval, changeBatch, changeItem, changeSet, type StoredSubmission } from './schema.js';

const MAX_PAGE = 500;
const MAX_BATCH = 1000;
const DAY_MS = 24 * 3_600_000;
/** First key of the two-key advisory lock `startExecution` takes per requester ('aex1'). */
const START_LOCK_NAMESPACE = 0x6165_7831;
const OUTCOMES_REFUSED = 'item outcomes rejected: change-set is not executing';
const BATCH_REFUSED = 'batch outcomes rejected: change-set is not executing';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PostgresChangeSetRepositoryOptions {
  /** Audit log bound to the transaction of a state change. Tests wrap it to inject failures. */
  readonly auditFor?: (tx: DbExecutor) => AuditLog;
}

type ChangeSetRow = typeof changeSet.$inferSelect;
type ChangeItemRow = typeof changeItem.$inferSelect;
type ChangeBatchRow = typeof changeBatch.$inferSelect;
type ApprovalRow = typeof approval.$inferSelect;
type SubmitRequest = Parameters<ChangeSetRepository['submitForApproval']>[0];
type SubmitResult = Awaited<ReturnType<ChangeSetRepository['submitForApproval']>>;
type DecisionRequestOf = Parameters<ChangeSetRepository['recordDecision']>[0];
type DecisionResult = Awaited<ReturnType<ChangeSetRepository['recordDecision']>>;
type StartRequestOf = Parameters<ChangeSetRepository['startExecution']>[0];
type StartResult = Awaited<ReturnType<ChangeSetRepository['startExecution']>>;
type ClaimResult = Awaited<ReturnType<ChangeSetRepository['claimBatch']>>;
type CancelResult = Awaited<ReturnType<ChangeSetRepository['requestCancel']>>;
type CompleteResult = Awaited<ReturnType<ChangeSetRepository['completeBatch']>>;

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
    ...(row.errorStatus === null ? {} : { errorStatus: row.errorStatus }),
    configHash: row.configHash,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.preparedAt === null ? {} : { preparedAt: row.preparedAt }),
    expiresAt: row.expiresAt,
    approvalRound: row.approvalRound,
    ...(row.submission === null ? {} : { submission: fromStoredSubmission(row.submission) }),
    ...(row.approvalPlan === null ? {} : { approvalPlan: row.approvalPlan }),
    ...(row.awaitingRole === null ? {} : { awaitingRole: row.awaitingRole }),
    ...(row.executionActor === null ||
    row.executionGroups === null ||
    row.executionCorrelationId === null ||
    row.executionStartedAt === null
      ? {}
      : {
          executionRequest: {
            actor: row.executionActor,
            groups: row.executionGroups,
            ...(row.executionClientId === null ? {} : { clientId: row.executionClientId }),
            correlationId: row.executionCorrelationId,
            startedAt: row.executionStartedAt,
          },
        }),
    ...(row.cancelRequestedBy === null || row.cancelCorrelationId === null || row.cancelRequestedAt === null
      ? {}
      : {
          cancelRequest: {
            actor: row.cancelRequestedBy,
            correlationId: row.cancelCorrelationId,
            requestedAt: row.cancelRequestedAt,
          },
        }),
  };
}

function toStoredSubmission(s: Submission): StoredSubmission {
  return {
    actor: s.actor,
    groups: [...s.groups],
    ...(s.clientId === undefined ? {} : { clientId: s.clientId }),
    correlationId: s.correlationId,
    at: s.at.toISOString(),
    role: s.role,
    rule: s.rule,
  };
}

/** JSON keeps `at` as a string; consumers sort and compare on it as a `Date`. */
function fromStoredSubmission(s: StoredSubmission): Submission {
  return {
    actor: s.actor,
    groups: [...s.groups],
    ...(s.clientId === undefined ? {} : { clientId: s.clientId }),
    correlationId: s.correlationId,
    at: new Date(s.at),
    role: s.role,
    rule: s.rule,
  };
}

function toApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    changesetId: row.changesetId,
    round: row.round,
    step: row.step,
    role: row.role,
    approver: row.approver,
    ...(row.approverName === null ? {} : { approverName: row.approverName }),
    decision: row.decision,
    ...(row.comment === null ? {} : { comment: row.comment }),
    hash: row.hash,
    itemCount: row.itemCount,
    channel: row.channel,
    ...(row.authTime === null ? {} : { authTime: row.authTime }),
    ...(row.clientId === null ? {} : { clientId: row.clientId }),
    correlationId: row.correlationId,
    ts: row.ts,
  };
}

function toBatch(row: ChangeBatchRow): BatchRecord {
  return {
    changesetId: row.changesetId,
    batchNo: row.batchNo,
    attempt: row.attempt,
    targetIds: row.targetIds,
    ...(row.upstreamBatchId === null || row.plan === null
      ? {}
      : { submission: { upstreamBatchId: row.upstreamBatchId, plan: row.plan } }),
  };
}

function countsOf(row: ChangeBatchRow): BatchCounts {
  return { written: row.written, failed: row.failed, skipped: row.skipped };
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
    return guarded('change-set create', () =>
      this.db.transaction(async (tx) => {
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
      }),
    );
  }

  async appendItems(changesetId: string, items: readonly ChangeItemRecord[]): Promise<number> {
    if (!UUID.test(changesetId)) throw new Error('unknown change-set');
    return guarded('change items append', () =>
      this.db.transaction(async (tx) => {
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
      }),
    );
  }

  async stats(changesetId: string): Promise<ChangeSetStats> {
    if (!UUID.test(changesetId)) return structuredClone(EMPTY_STATS);
    return guarded('change-set stats', () => computeStats(this.db, changesetId));
  }

  async get(changesetId: string): Promise<ChangeSetRecord | undefined> {
    if (!UUID.test(changesetId)) return undefined;
    const [row] = await guarded('change-set read', () =>
      this.db.select().from(changeSet).where(eq(changeSet.id, changesetId)),
    );
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
    const rows = await guarded('change items page', () =>
      this.db
        .select()
        .from(changeItem)
        .where(and(...conditions))
        .orderBy(asc(changeItem.targetId))
        .limit(query.limit),
    );
    return rows.map(toItem);
  }

  async completePreparation(
    changesetId: string,
    outcome:
      | { status: 'prepared'; hash: string; stats: ChangeSetStats; preparedAt: Date }
      | { status: 'failed'; errorCode: string; upstreamStatus?: number },
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
        : { status: 'failed' as const, errorCode: outcome.errorCode, errorStatus: outcome.upstreamStatus ?? null, updatedAt: sql`now()` };
    return this.compareAndSet(changesetId, ['preparing'], set, audit);
  }

  async transition(
    changesetId: string,
    from: readonly ChangeSetStatus[],
    to: ChangeSetStatus,
    audit: AuditEventInput,
    extra?: { errorCode?: string; expiredBefore?: Date; unlessBatches?: boolean },
  ): Promise<ChangeSetRecord | undefined> {
    if (!UUID.test(changesetId) || from.length === 0) return undefined;
    const set: PgUpdateSetSource<typeof changeSet> = {
      status: to,
      ...(extra?.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
      updatedAt: sql`now()`,
    };
    return this.compareAndSet(changesetId, from, set, audit, extra?.expiredBefore, extra?.unlessBatches === true);
  }

  async submitForApproval(req: SubmitRequest): Promise<SubmitResult> {
    if (!UUID.test(req.changesetId)) return { ok: false, reason: 'not_found' };
    return guarded('change-set submit', () =>
      this.db.transaction(async (tx): Promise<SubmitResult> => {
        const [row] = await tx.select().from(changeSet).where(eq(changeSet.id, req.changesetId)).for('update');
        if (row === undefined) return { ok: false, reason: 'not_found' };
        const record = toRecord(row);
        // Judged at the submission time: the request carries no other clock (CS-6).
        if (record.status === 'prepared' && isExpiryDue(record, req.submission.at)) {
          await tx
            .update(changeSet)
            .set({ status: 'expired', updatedAt: sql`now()` })
            .where(eq(changeSet.id, req.changesetId));
          await this.auditFor(tx).append(
            changesetTransitionEvent({
              id: randomUUID(),
              actor: 'system',
              changeset: record,
              from: record.status,
              to: 'expired',
              correlationId: req.submission.correlationId,
            }),
          );
          return { ok: false, reason: 'expired' };
        }
        if (record.hash === undefined || record.hash !== req.expectedHash) return { ok: false, reason: 'hash_mismatch' };
        if (record.status !== 'prepared') return { ok: false, reason: 'not_prepared' };
        const first = req.plan.steps[0];
        if (first === undefined) throw new Error('approval plan has no steps');
        const [updated] = await tx
          .update(changeSet)
          .set({
            status: 'pending_approval',
            approvalRound: sql`${changeSet.approvalRound} + 1`,
            submission: toStoredSubmission(req.submission),
            approvalPlan: structuredClone(req.plan),
            awaitingRole: first,
            updatedAt: sql`now()`,
          })
          .where(eq(changeSet.id, req.changesetId))
          .returning();
        if (updated === undefined) throw new Error('change-set submit update returned no row');
        const audit = this.auditFor(tx);
        await audit.append(req.audit.transition);
        await audit.append(req.audit.requested);
        // `req.notifications` go to the outbox once it exists (Phase 6 notifications plan); passed as [] until then.
        return { ok: true, changeset: toRecord(updated) };
      }),
    );
  }

  async approvals(changesetId: string, round?: number): Promise<readonly ApprovalRecord[]> {
    if (!UUID.test(changesetId)) return [];
    const conditions: SQL[] = [eq(approval.changesetId, changesetId)];
    if (round !== undefined) conditions.push(eq(approval.round, round));
    const rows = await guarded('approvals read', () =>
      this.db
        .select()
        .from(approval)
        .where(and(...conditions))
        .orderBy(asc(approval.round), asc(approval.step)),
    );
    return rows.map(toApproval);
  }

  async recordDecision(req: DecisionRequestOf): Promise<DecisionResult> {
    if (!UUID.test(req.changesetId)) return { ok: false, reason: 'not_pending' };
    return guarded('approval decision', async () => {
      try {
        return await this.db.transaction(async (tx): Promise<DecisionResult> => {
          // The row lock serializes decisions of one change-set: the loser of a race reads the
          // winner's status and row below and answers not_pending.
          const [row] = await tx.select().from(changeSet).where(eq(changeSet.id, req.changesetId)).for('update');
          if (row?.status !== 'pending_approval' || row.approvalRound !== req.round) {
            return { ok: false, reason: 'not_pending' };
          }
          const [decided] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(approval)
            .where(
              and(
                eq(approval.changesetId, req.changesetId),
                eq(approval.round, req.round),
                eq(approval.decision, 'approved'),
              ),
            );
          if ((decided?.n ?? 0) + 1 !== req.step) return { ok: false, reason: 'not_pending' };
          const r = req.record;
          await tx.insert(approval).values({
            id: r.id,
            changesetId: req.changesetId,
            round: req.round,
            step: req.step,
            role: r.role,
            approver: r.approver,
            approverName: r.approverName ?? null,
            decision: r.decision,
            comment: r.comment ?? null,
            hash: r.hash,
            itemCount: r.itemCount,
            channel: r.channel,
            authTime: r.authTime ?? null,
            clientId: r.clientId ?? null,
            correlationId: r.correlationId,
            ts: r.ts,
          });
          const set: PgUpdateSetSource<typeof changeSet> =
            req.next.kind === 'next_step'
              ? { awaitingRole: req.next.awaitingRole, updatedAt: sql`now()` }
              : {
                  status: req.next.kind === 'returned' ? 'prepared' : req.next.kind,
                  awaitingRole: null,
                  updatedAt: sql`now()`,
                };
          const [updated] = await tx.update(changeSet).set(set).where(eq(changeSet.id, req.changesetId)).returning();
          if (updated === undefined) throw new Error('approval decision update returned no row');
          const audit = this.auditFor(tx);
          for (const event of req.audit) await audit.append(event);
          // `req.notifications` go to the outbox once it exists (Phase 6 notifications plan); passed as [] until then.
          return { ok: true, changeset: toRecord(updated) };
        });
      } catch (error) {
        // A concurrent decision of the same step stored its row first: the unique key refused ours.
        if (pgCode(error) === '23505') return { ok: false, reason: 'not_pending' };
        throw error;
      }
    });
  }

  async errorCounts(changesetId: string): Promise<Readonly<Record<string, number>>> {
    if (!UUID.test(changesetId)) return {};
    const rows = await guarded('item error counts', () =>
      this.db
        .select({ error: changeItem.error, n: sql<number>`count(*)::int` })
        .from(changeItem)
        .where(and(eq(changeItem.changesetId, changesetId), sql`${changeItem.error} is not null`))
        .groupBy(changeItem.error),
    );
    const counts: Record<string, number> = {};
    for (const { error, n } of rows) if (error !== null) counts[error] = n;
    return counts;
  }

  async recordItemOutcomes(changesetId: string, outcomes: readonly ItemOutcome[]): Promise<void> {
    if (!UUID.test(changesetId)) throw new Error(OUTCOMES_REFUSED);
    // The first outcome per target wins, as later ones would find the item no longer pending.
    const seen = new Set<string>();
    const rows: Record<string, unknown>[] = [];
    for (const o of outcomes) {
      if (seen.has(o.targetId)) continue;
      seen.add(o.targetId);
      rows.push({ target_id: o.targetId, status: o.status, error: o.error ?? null });
    }
    await guarded('item outcomes record', () =>
      this.db.transaction(async (tx) => {
        // Serializes outcome batches per change-set so the recomputed stats see every batch.
        const [parent] = await tx
          .select({ status: changeSet.status })
          .from(changeSet)
          .where(eq(changeSet.id, changesetId))
          .for('update');
        // Item statuses are hashed content: they change only while executing or rolling back (CS-4).
        if (parent === undefined || (parent.status !== 'executing' && parent.status !== 'rolling_back')) {
          throw new Error(OUTCOMES_REFUSED);
        }
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
      }),
    );
  }

  async startExecution(req: StartRequestOf): Promise<StartResult> {
    if (!UUID.test(req.changesetId)) return { ok: false, reason: 'not_found' };
    return guarded('change-set start', () =>
      this.db.transaction(
        async (tx): Promise<StartResult> => {
          // The row lock serializes starts of one change-set: a second start finds it executing.
          const [row] = await tx.select().from(changeSet).where(eq(changeSet.id, req.changesetId)).for('update');
          if (row === undefined) return { ok: false, reason: 'not_found' };
          const record = toRecord(row);
          if (isExpiryDue(record, req.now)) {
            await tx
              .update(changeSet)
              .set({ status: 'expired', updatedAt: sql`now()` })
              .where(eq(changeSet.id, req.changesetId));
            await this.auditFor(tx).append(req.event({ kind: 'expired', from: record.status }, record));
            return { ok: false, reason: 'expired' };
          }
          if (record.hash === undefined) return { ok: false, reason: 'not_executable' };
          if (record.hash !== req.expectedHash) return { ok: false, reason: 'hash_mismatch' };
          if (record.status !== 'prepared' && record.status !== 'approved') return { ok: false, reason: 'not_executable' };
          if (record.status === 'approved' && !(await approvalsCover(tx, record, req.expectedHash))) {
            return { ok: false, reason: 'not_approved' };
          }
          // Starts of one requester serialize here, before the usage is read (POL-4). At READ
          // COMMITTED each later statement sees the starts that committed while this one waited.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${START_LOCK_NAMESPACE}::int4, hashtext(${record.requester}))`,
          );
          if (req.limits !== undefined) {
            const since = new Date(req.now.getTime() - DAY_MS);
            const limit = evaluateLimits(req.limits, record.stats.included, await usageOf(tx, record.requester, since));
            if (limit !== undefined) {
              await this.auditFor(tx).append(req.event({ kind: 'limit_denied', limit, role: req.limits.role }, record));
              return { ok: false, reason: 'limit_exceeded', limit };
            }
          }
          const [updated] = await tx
            .update(changeSet)
            .set({
              status: 'executing',
              executionActor: req.request.actor,
              executionGroups: [...req.request.groups],
              executionClientId: req.request.clientId ?? null,
              executionCorrelationId: req.request.correlationId,
              executionStartedAt: req.now,
              // POL-6: the submission of a start without approval; an approved one keeps its own.
              ...(req.submission !== undefined && record.status === 'prepared'
                ? { submission: toStoredSubmission(req.submission) }
                : {}),
              updatedAt: sql`now()`,
            })
            .where(and(eq(changeSet.id, req.changesetId), inArray(changeSet.status, ['prepared', 'approved'])))
            .returning();
          if (updated === undefined) return { ok: false, reason: 'not_executable' };
          await this.auditFor(tx).append(req.event({ kind: 'executing', from: record.status }, record));
          return { ok: true, changeset: toRecord(updated) };
        },
        { isolationLevel: 'read committed' },
      ),
    );
  }

  async requestCancel(changesetId: string, cancel: CancelRequest): Promise<CancelResult> {
    if (!UUID.test(changesetId)) return { ok: false };
    return guarded('change-set cancel request', () =>
      this.db.transaction(async (tx): Promise<CancelResult> => {
        const [row] = await tx.select().from(changeSet).where(eq(changeSet.id, changesetId)).for('update');
        if (row === undefined) return { ok: false };
        if (row.status !== 'executing') return { ok: false, status: row.status };
        // The first request wins: a later one answers the stored request unchanged.
        if (row.cancelRequestedBy !== null) return { ok: true, changeset: toRecord(row) };
        const [updated] = await tx
          .update(changeSet)
          .set({
            cancelRequestedBy: cancel.actor,
            cancelCorrelationId: cancel.correlationId,
            cancelRequestedAt: cancel.requestedAt,
            updatedAt: sql`now()`,
          })
          .where(eq(changeSet.id, changesetId))
          .returning();
        if (updated === undefined) throw new Error('cancel request update returned no row');
        return { ok: true, changeset: toRecord(updated) };
      }),
    );
  }

  async usage(requester: string, since: Date): Promise<ExecutionUsage> {
    return guarded('execution usage', () => usageOf(this.db, requester, since));
  }

  async claimBatch(changesetId: string, batchNo: number, attempt: number, size: number): Promise<ClaimResult> {
    if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH) {
      throw new Error(`batch size must be between 1 and ${MAX_BATCH}`);
    }
    if (!UUID.test(changesetId)) return { kind: 'empty' };
    return guarded('batch claim', () =>
      this.db.transaction(async (tx): Promise<ClaimResult> => {
        // The change-set row lock serializes claims and completions of one change-set, and holds
        // off a status change until this claim commits: no batch is claimed after it left executing.
        const [parent] = await tx
          .select({ status: changeSet.status })
          .from(changeSet)
          .where(eq(changeSet.id, changesetId))
          .for('update');
        if (parent === undefined) return { kind: 'empty' };
        const executing = parent.status === 'executing';
        let row = await readBatch(tx, changesetId, batchNo);
        if (row === undefined) {
          if (!executing) return { kind: 'fenced' };
          // Continue after the last target of the highest existing batch.
          const [highest] = await tx
            .select({ lastTarget: changeBatch.lastTarget })
            .from(changeBatch)
            .where(eq(changeBatch.changesetId, changesetId))
            .orderBy(desc(changeBatch.batchNo))
            .limit(1);
          const conditions: SQL[] = [eq(changeItem.changesetId, changesetId), eq(changeItem.status, 'pending')];
          if (highest !== undefined) conditions.push(gt(changeItem.targetId, highest.lastTarget));
          const items = await tx
            .select()
            .from(changeItem)
            .where(and(...conditions))
            .orderBy(asc(changeItem.targetId))
            .limit(size);
          const last = items[items.length - 1];
          if (last === undefined) return { kind: 'empty' };
          const [inserted] = await tx
            .insert(changeBatch)
            .values({
              changesetId,
              batchNo,
              attempt,
              state: 'open',
              targetIds: items.map((i) => i.targetId),
              lastTarget: last.targetId,
            })
            .onConflictDoNothing()
            .returning();
          if (inserted !== undefined) return { kind: 'claimed', batch: toBatch(inserted), items: items.map(toItem) };
          // Another claim inserted it first: answer as for an existing batch.
          row = await readBatch(tx, changesetId, batchNo);
          if (row === undefined) throw new Error('batch claim found no row after a conflict');
        }
        if (row.state === 'done') return { kind: 'done', counts: countsOf(row) };
        if (!executing || row.attempt >= attempt) return { kind: 'fenced' };
        const [taken] = await tx
          .update(changeBatch)
          .set({ attempt, updatedAt: sql`now()` })
          .where(
            and(
              eq(changeBatch.changesetId, changesetId),
              eq(changeBatch.batchNo, batchNo),
              lt(changeBatch.attempt, attempt),
              eq(changeBatch.state, 'open'),
            ),
          )
          .returning();
        if (taken === undefined) {
          // Lost to a completion or a newer attempt between the read and the update.
          const current = await readBatch(tx, changesetId, batchNo);
          return current?.state === 'done' ? { kind: 'done', counts: countsOf(current) } : { kind: 'fenced' };
        }
        const items = await tx
          .select()
          .from(changeItem)
          .where(and(eq(changeItem.changesetId, changesetId), inArray(changeItem.targetId, taken.targetIds)))
          .orderBy(asc(changeItem.targetId));
        return { kind: 'claimed', batch: toBatch(taken), items: items.map(toItem) };
      }),
    );
  }

  async recordSubmission(
    changesetId: string,
    batchNo: number,
    attempt: number,
    submission: BatchSubmission,
  ): Promise<boolean> {
    if (!UUID.test(changesetId)) return false;
    const rows = await guarded('batch submission record', () =>
      this.db
        .update(changeBatch)
        .set({ upstreamBatchId: submission.upstreamBatchId, plan: [...submission.plan], updatedAt: sql`now()` })
        .where(
          and(
            eq(changeBatch.changesetId, changesetId),
            eq(changeBatch.batchNo, batchNo),
            eq(changeBatch.attempt, attempt),
            eq(changeBatch.state, 'open'),
          ),
        )
        .returning({ batchNo: changeBatch.batchNo }),
    );
    return rows.length > 0;
  }

  async completeBatch(
    changesetId: string,
    batchNo: number,
    attempt: number,
    outcomes: readonly ItemOutcome[],
    audit: AuditEventInput,
  ): Promise<CompleteResult> {
    if (!UUID.test(changesetId)) return { ok: false };
    return guarded('batch complete', () =>
      this.db.transaction(async (tx): Promise<CompleteResult> => {
        // Same lock order as claimBatch: the change-set row, then the batch row.
        const [parent] = await tx
          .select({ status: changeSet.status })
          .from(changeSet)
          .where(eq(changeSet.id, changesetId))
          .for('update');
        if (parent === undefined) return { ok: false };
        const [row] = await tx
          .select()
          .from(changeBatch)
          .where(and(eq(changeBatch.changesetId, changesetId), eq(changeBatch.batchNo, batchNo)))
          .for('update');
        if (row?.attempt !== attempt || row.state !== 'open') return { ok: false };
        if (parent.status !== 'executing') throw new Error(BATCH_REFUSED);
        // The first outcome per target of this batch; outcomes for other targets are ignored.
        const inBatch = new Set(row.targetIds);
        const seen = new Set<string>();
        const rows: Record<string, unknown>[] = [];
        for (const o of outcomes) {
          if (!inBatch.has(o.targetId) || seen.has(o.targetId)) continue;
          seen.add(o.targetId);
          rows.push({ target_id: o.targetId, status: o.status, error: o.error ?? null });
        }
        const counts: { -readonly [K in keyof BatchCounts]: number } = { written: 0, failed: 0, skipped: 0 };
        if (rows.length > 0) {
          // Only pending items change, and only those count.
          const applied = await tx.execute<{ status: ItemOutcome['status'] }>(sql`
            UPDATE change_item AS ci
            SET status = o.status, error = COALESCE(o.error, ci.error), updated_at = now()
            FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS o(target_id text, status text, error text)
            WHERE ci.changeset_id = ${changesetId}::uuid
              AND ci.target_id = o.target_id
              AND ci.status = 'pending'
            RETURNING ci.status`);
          for (const r of applied.rows) counts[r.status] += 1;
        }
        const stats = await computeStats(tx, changesetId);
        await tx.update(changeSet).set({ stats, updatedAt: sql`now()` }).where(eq(changeSet.id, changesetId));
        await tx
          .update(changeBatch)
          .set({ state: 'done', ...counts, updatedAt: sql`now()` })
          .where(and(eq(changeBatch.changesetId, changesetId), eq(changeBatch.batchNo, batchNo)));
        await this.auditFor(tx).append(audit);
        return { ok: true, counts };
      }),
    );
  }

  /** Compare-and-set on status; no matching row writes no audit event and returns undefined. */
  private async compareAndSet(
    changesetId: string,
    from: readonly ChangeSetStatus[],
    set: PgUpdateSetSource<typeof changeSet>,
    audit: AuditEventInput,
    expiredBefore?: Date,
    unlessBatches = false,
  ): Promise<ChangeSetRecord | undefined> {
    return guarded('change-set update', () =>
      this.db.transaction(async (tx) => {
        if (unlessBatches) {
          // The parent row lock claimBatch takes: a claim either committed before (its batch is seen
          // by the next statement, read committed) or waits until this change committed (and fences).
          await tx.select({ id: changeSet.id }).from(changeSet).where(eq(changeSet.id, changesetId)).for('update');
          const [batch] = await tx
            .select({ batchNo: changeBatch.batchNo })
            .from(changeBatch)
            .where(eq(changeBatch.changesetId, changesetId))
            .limit(1);
          if (batch !== undefined) return undefined;
        }
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
      }),
    );
  }
}

/** SEC-9: every plan step of the current round holds an `approved` row for this hash. */
async function approvalsCover(db: DbExecutor, record: ChangeSetRecord, hash: string): Promise<boolean> {
  const plan = record.approvalPlan;
  if (plan === undefined || plan.steps.length === 0) return false;
  const rows = await db
    .select({ step: approval.step })
    .from(approval)
    .where(
      and(
        eq(approval.changesetId, record.id),
        eq(approval.round, record.approvalRound),
        eq(approval.decision, 'approved'),
        eq(approval.hash, hash),
      ),
    );
  const steps = new Set(rows.map((r) => r.step));
  return plan.steps.every((_, i) => steps.has(i + 1));
}

async function readBatch(db: DbExecutor, changesetId: string, batchNo: number): Promise<ChangeBatchRow | undefined> {
  const [row] = await db
    .select()
    .from(changeBatch)
    .where(and(eq(changeBatch.changesetId, changesetId), eq(changeBatch.batchNo, batchNo)));
  return row;
}

/**
 * Included records of the requester's executions started at or after `since`, and its executing
 * count (POL-4). The two branches of the filter use the indexes on (requester, execution_started_at)
 * and (requester, status).
 */
async function usageOf(db: Db | DbExecutor, requester: string, since: Date): Promise<ExecutionUsage> {
  const startedSince = sql`${changeSet.executionStartedAt} >= ${since}`;
  const isExecuting = sql`${changeSet.status} = 'executing'`;
  const [row] = await db
    .select({
      recordsSince: sql<number>`coalesce(sum((${changeSet.stats}->>'included')::int) filter (where ${startedSince}), 0)::int`,
      executing: sql<number>`(count(*) filter (where ${isExecuting}))::int`,
    })
    .from(changeSet)
    .where(and(eq(changeSet.requester, requester), sql`(${startedSince} or ${isExecuting})`));
  return { recordsSince: row?.recordsSince ?? 0, executing: row?.executing ?? 0 };
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
