import type {
  ApprovalPlan,
  ApprovalRecord,
  AuditEventInput,
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
  NewNotification,
  Submission,
} from '@aiops/core';
import { changesetTransitionEvent, compareTargetIds, EMPTY_STATS, evaluateLimits, isExpiryDue } from '@aiops/core';
import { createHash, randomUUID } from 'node:crypto';
import { InMemoryAuditLog } from './in-memory-audit-log.js';
import { InMemoryNotificationOutbox } from './in-memory-notification-outbox.js';

const MAX_PAGE = 500;
const MAX_BATCH = 1000;
const DAY_MS = 24 * 3_600_000;
const NO_COUNTS: BatchCounts = Object.freeze({ written: 0, failed: 0, skipped: 0 });

interface Entry {
  record: ChangeSetRecord;
  readonly items: Map<string, ChangeItemRecord>;
  approvals: ApprovalRecord[];
}

/** A write batch row (EXE-3): fenced by `attempt`, frozen once `done`. */
interface Batch {
  attempt: number;
  state: 'open' | 'done';
  readonly targetIds: readonly string[];
  readonly lastTarget: string;
  submission?: BatchSubmission;
  counts: BatchCounts;
}

type StartRequestOf = Parameters<ChangeSetRepository['startExecution']>[0];
type StartResult = Awaited<ReturnType<ChangeSetRepository['startExecution']>>;
type ClaimResult = Awaited<ReturnType<ChangeSetRepository['claimBatch']>>;

function copyDate(d: Date): Date {
  return new Date(d.getTime());
}

function copyRecord(r: ChangeSetRecord): ChangeSetRecord {
  return structuredClone(r);
}

function copyItem(i: ChangeItemRecord): ChangeItemRecord {
  return structuredClone(i);
}

/** In-memory ChangeSetRepository for unit tests. Hands out copies, never internal objects. */
export class InMemoryChangeSetRepository implements ChangeSetRepository {
  readonly audit: InMemoryAuditLog;
  /** Outbox rows stored with the state change they announce (NTF-1, NTF-3). */
  readonly outbox: InMemoryNotificationOutbox;
  /** Largest `appendItems` batch seen (NFR-7 tests). */
  largestAppend = 0;
  /** Largest `itemsPage` limit seen (NFR-7 tests). */
  largestPage = 0;
  private readonly entries = new Map<string, Entry>();
  private readonly batches = new Map<string, Map<number, Batch>>();
  /** Highest batch number per change-set, tracked as batches are created. */
  private readonly highestBatch = new Map<string, number>();

  constructor(audit: InMemoryAuditLog = new InMemoryAuditLog(), outbox = new InMemoryNotificationOutbox(audit)) {
    this.audit = audit;
    this.outbox = outbox;
  }

  async create(cs: NewChangeSet, audit: AuditEventInput): Promise<ChangeSetRecord> {
    if (this.entries.has(cs.id)) throw new Error(`change-set ${cs.id} already exists`);
    const record: ChangeSetRecord = {
      id: cs.id,
      operation: cs.operation,
      connection: cs.connection,
      requester: cs.requester,
      ...(cs.clientId === undefined ? {} : { clientId: cs.clientId }),
      args: structuredClone(cs.args),
      status: 'preparing',
      stats: EMPTY_STATS,
      configHash: cs.configHash,
      correlationId: cs.correlationId,
      createdAt: copyDate(cs.createdAt),
      updatedAt: new Date(),
      expiresAt: copyDate(cs.expiresAt),
      approvalRound: 0,
      ...(cs.derivedFrom === undefined ? {} : { derivedFrom: cs.derivedFrom }),
    };
    // Apply before awaiting the audit append so concurrent callers see the change; undo if the append fails.
    this.entries.set(cs.id, { record, items: new Map(), approvals: [] });
    try {
      await this.audit.append(audit);
    } catch (error) {
      this.entries.delete(cs.id);
      throw error;
    }
    return copyRecord(record);
  }

  appendItems(changesetId: string, items: readonly ChangeItemRecord[]): Promise<number> {
    this.largestAppend = Math.max(this.largestAppend, items.length);
    const entry = this.entries.get(changesetId);
    if (entry === undefined) return Promise.reject(new Error(`unknown change-set ${changesetId}`));
    if (entry.record.status !== 'preparing') return Promise.reject(new Error('change-set is not preparing'));
    for (const it of items) {
      if (it.status !== 'pending' && it.status !== 'excluded') {
        return Promise.reject(new Error(`item status ${it.status} is not allowed on append`));
      }
    }
    let inserted = 0;
    for (const it of items) {
      if (entry.items.has(it.targetId)) continue;
      entry.items.set(it.targetId, copyItem(it));
      inserted += 1;
    }
    return Promise.resolve(inserted);
  }

  stats(changesetId: string): Promise<ChangeSetStats> {
    const entry = this.entries.get(changesetId);
    return Promise.resolve(entry === undefined ? structuredClone(EMPTY_STATS) : computeStats(entry.items));
  }

  get(changesetId: string): Promise<ChangeSetRecord | undefined> {
    const entry = this.entries.get(changesetId);
    return Promise.resolve(entry === undefined ? undefined : copyRecord(entry.record));
  }

  itemsPage(changesetId: string, query: ItemsPageQuery): Promise<readonly ChangeItemRecord[]> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_PAGE) {
      return Promise.reject(new Error(`limit must be between 1 and ${MAX_PAGE}`));
    }
    this.largestPage = Math.max(this.largestPage, query.limit);
    const entry = this.entries.get(changesetId);
    if (entry === undefined) return Promise.resolve([]);
    const after = query.after;
    const page = [...entry.items.values()]
      .filter((i) => query.status === undefined || i.status === query.status)
      .filter((i) => after === undefined || compareTargetIds(i.targetId, after) > 0)
      .sort((a, b) => compareTargetIds(a.targetId, b.targetId))
      .slice(0, query.limit)
      .map(copyItem);
    return Promise.resolve(page);
  }

  pendingApprovals(q: {
    roles: readonly string[];
    excludeRequester: string;
    after?: { submittedAt: Date; id: string };
    limit: number;
  }): Promise<readonly ChangeSetRecord[]> {
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > MAX_PAGE) {
      return Promise.reject(new Error(`limit must be between 1 and ${MAX_PAGE}`));
    }
    if (q.roles.length === 0) return Promise.resolve([]);
    const after = q.after;
    const rows = [...this.entries.values()]
      .map((e) => e.record)
      .filter(
        (r) =>
          r.status === 'pending_approval' &&
          r.awaitingRole !== undefined &&
          q.roles.includes(r.awaitingRole) &&
          r.requester !== q.excludeRequester &&
          r.submission !== undefined,
      )
      .sort((a, b) => {
        const byTime = (b.submission?.at.getTime() ?? 0) - (a.submission?.at.getTime() ?? 0);
        return byTime !== 0 ? byTime : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      })
      .filter((r) => {
        if (after === undefined) return true;
        const t = r.submission?.at.getTime() ?? 0;
        return t < after.submittedAt.getTime() || (t === after.submittedAt.getTime() && r.id < after.id);
      });
    return Promise.resolve(rows.slice(0, q.limit).map(copyRecord));
  }

  sampleItems(changesetId: string, seed: string, size: number): Promise<readonly ChangeItemRecord[]> {
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE) {
      return Promise.reject(new Error(`size must be between 1 and ${MAX_PAGE}`));
    }
    const entry = this.entries.get(changesetId);
    if (entry === undefined) return Promise.resolve([]);
    const key = (targetId: string): string => createHash('md5').update(seed + targetId).digest('hex');
    const sample = [...entry.items.values()]
      .filter((i) => i.status !== 'excluded')
      .map((i) => ({ i, k: key(i.targetId) }))
      .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i.targetId < b.i.targetId ? -1 : a.i.targetId > b.i.targetId ? 1 : 0))
      .slice(0, size)
      .map((x) => copyItem(x.i));
    return Promise.resolve(sample);
  }

  deriveCheck(
    sourceId: string,
    exclude: readonly string[],
    include: readonly string[],
  ): Promise<{ unknown: number; includedAfter: number }> {
    const ex = new Set(exclude);
    const inc = new Set(include);
    const items = this.entries.get(sourceId)?.items ?? new Map<string, ChangeItemRecord>();
    let unknown = 0;
    for (const t of new Set([...ex, ...inc])) {
      const it = items.get(t);
      const qualifies = ex.has(t) ? !inc.has(t) && it?.status === 'pending' : it !== undefined && isRequesterExclusion(it);
      if (!qualifies) unknown += 1;
    }
    let includedAfter = 0;
    for (const it of items.values()) if (derivedItem(it, ex, inc).status !== 'excluded') includedAfter += 1;
    return Promise.resolve({ unknown, includedAfter });
  }

  copyItems(newId: string, sourceId: string, exclude: readonly string[], include: readonly string[]): Promise<number> {
    const entry = this.entries.get(newId);
    if (entry === undefined) return Promise.reject(new Error('unknown change-set'));
    if (entry.record.status !== 'preparing') return Promise.reject(new Error('change-set is not preparing'));
    if (entry.items.size > 0) return Promise.reject(new Error('change-set already has items'));
    const ex = new Set(exclude);
    const inc = new Set(include);
    const source = this.entries.get(sourceId)?.items ?? new Map<string, ChangeItemRecord>();
    for (const it of source.values()) entry.items.set(it.targetId, derivedItem(it, ex, inc));
    return Promise.resolve(source.size);
  }

  async completePreparation(
    changesetId: string,
    outcome:
      | { status: 'prepared'; hash: string; stats: ChangeSetStats; preparedAt: Date }
      | { status: 'failed'; errorCode: string; upstreamStatus?: number },
    audit: AuditEventInput,
  ): Promise<ChangeSetRecord | undefined> {
    const entry = this.entries.get(changesetId);
    if (entry?.record.status !== 'preparing') return undefined;
    // Check and apply synchronously (compare-and-set); undo if the audit append fails.
    const next: ChangeSetRecord =
      outcome.status === 'prepared'
        ? {
            ...entry.record,
            status: 'prepared',
            hash: outcome.hash,
            stats: structuredClone(outcome.stats),
            preparedAt: copyDate(outcome.preparedAt),
            updatedAt: new Date(),
          }
        : {
            ...entry.record,
            status: 'failed',
            errorCode: outcome.errorCode,
            ...(outcome.upstreamStatus === undefined ? {} : { errorStatus: outcome.upstreamStatus }),
            updatedAt: new Date(),
          };
    await this.commit(entry, next, audit);
    return copyRecord(next);
  }

  async transition(
    changesetId: string,
    from: readonly ChangeSetStatus[],
    to: ChangeSetStatus,
    audit: AuditEventInput,
    extra?: {
      errorCode?: string;
      expiredBefore?: Date;
      unlessBatches?: boolean;
      notifications?: readonly NewNotification[];
    },
  ): Promise<ChangeSetRecord | undefined> {
    const entry = this.entries.get(changesetId);
    const expiredBefore = extra?.expiredBefore;
    if (entry === undefined || !from.includes(entry.record.status)) return undefined;
    if (expiredBefore !== undefined && entry.record.expiresAt.getTime() > expiredBefore.getTime()) return undefined;
    if (extra?.unlessBatches === true && (this.batches.get(changesetId)?.size ?? 0) > 0) return undefined;
    // Check and apply synchronously (compare-and-set); undo if the audit append fails.
    const next: ChangeSetRecord = {
      ...entry.record,
      status: to,
      updatedAt: new Date(),
      ...(extra?.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
    };
    await this.commit(entry, next, audit);
    this.outbox.enqueue(changesetId, extra?.notifications ?? [], new Date());
    return copyRecord(next);
  }

  async submitForApproval(req: {
    changesetId: string;
    expectedHash: string;
    submission: Submission;
    plan: ApprovalPlan;
    audit: { transition: AuditEventInput; requested: AuditEventInput };
    notifications: readonly NewNotification[];
  }): ReturnType<ChangeSetRepository['submitForApproval']> {
    const entry = this.entries.get(req.changesetId);
    if (entry === undefined) return { ok: false, reason: 'not_found' };
    const record = entry.record;
    if (record.status === 'prepared' && isExpiryDue(record, req.submission.at)) {
      const expired: ChangeSetRecord = { ...record, status: 'expired', updatedAt: new Date() };
      await this.commit(
        entry,
        expired,
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
    const next: ChangeSetRecord = {
      ...record,
      status: 'pending_approval',
      approvalRound: record.approvalRound + 1,
      submission: structuredClone(req.submission),
      approvalPlan: structuredClone(req.plan),
      awaitingRole: first,
      updatedAt: new Date(),
    };
    await this.commit(entry, next, req.audit.transition, req.audit.requested);
    this.outbox.enqueue(req.changesetId, req.notifications, req.submission.at);
    return { ok: true, changeset: copyRecord(next) };
  }

  approvals(changesetId: string, round?: number): Promise<readonly ApprovalRecord[]> {
    const rows = (this.entries.get(changesetId)?.approvals ?? [])
      .filter((a) => round === undefined || a.round === round)
      .sort((a, b) => a.round - b.round || a.step - b.step)
      .map((a) => structuredClone(a));
    return Promise.resolve(rows);
  }

  async recordDecision(req: {
    changesetId: string;
    round: number;
    step: number;
    record: ApprovalRecord;
    next: { kind: 'rejected' | 'returned' | 'approved' } | { kind: 'next_step'; awaitingRole: string };
    audit: readonly AuditEventInput[];
    notifications: readonly NewNotification[];
  }): ReturnType<ChangeSetRepository['recordDecision']> {
    // Synchronous up to the audit append: the in-memory form of one transaction.
    const entry = this.entries.get(req.changesetId);
    if (entry === undefined) return { ok: false, reason: 'not_pending' };
    const record = entry.record;
    const decidedSteps = entry.approvals.filter((a) => a.round === record.approvalRound && a.decision === 'approved');
    if (
      record.status !== 'pending_approval' ||
      record.approvalRound !== req.round ||
      decidedSteps.length + 1 !== req.step ||
      entry.approvals.some((a) => a.round === req.round && a.step === req.step && a.decision === 'approved')
    ) {
      return { ok: false, reason: 'not_pending' };
    }
    const { awaitingRole: _previous, ...rest } = record; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
    const base = { ...rest, updatedAt: new Date() };
    const next: ChangeSetRecord =
      req.next.kind === 'next_step'
        ? { ...base, awaitingRole: req.next.awaitingRole }
        : { ...base, status: req.next.kind === 'returned' ? 'prepared' : req.next.kind };
    const previousApprovals = entry.approvals;
    entry.approvals = [...entry.approvals, structuredClone(req.record)];
    try {
      await this.commit(entry, next, ...req.audit);
    } catch (error) {
      entry.approvals = previousApprovals;
      throw error;
    }
    this.outbox.enqueue(req.changesetId, req.notifications, req.record.ts);
    return { ok: true, changeset: copyRecord(next) };
  }

  errorCounts(changesetId: string): Promise<Readonly<Record<string, number>>> {
    const counts: Record<string, number> = {};
    for (const it of this.entries.get(changesetId)?.items.values() ?? []) {
      if (it.error !== undefined) counts[it.error] = (counts[it.error] ?? 0) + 1;
    }
    return Promise.resolve(counts);
  }

  recordItemOutcomes(changesetId: string, outcomes: readonly ItemOutcome[]): Promise<void> {
    const entry = this.entries.get(changesetId);
    // Item statuses are hashed content: they change only while executing or rolling back (CS-4).
    if (entry === undefined || !OUTCOME_STATUSES.has(entry.record.status)) {
      return Promise.reject(new Error('item outcomes rejected: change-set is not executing'));
    }
    for (const o of outcomes) {
      const current = entry.items.get(o.targetId);
      if (current?.status !== 'pending') continue;
      entry.items.set(o.targetId, {
        ...current,
        status: o.status,
        ...(o.error === undefined ? {} : { error: o.error }),
      });
    }
    entry.record = { ...entry.record, stats: computeStats(entry.items), updatedAt: new Date() };
    return Promise.resolve();
  }

  async startExecution(req: StartRequestOf): Promise<StartResult> {
    // Everything up to the audit append runs synchronously: the in-memory form of one transaction
    // under the per-requester lock, so parallel starts see each other's status change.
    const entry = this.entries.get(req.changesetId);
    if (entry === undefined) return { ok: false, reason: 'not_found' };
    const record = entry.record;
    if (isExpiryDue(record, req.now)) {
      const expired: ChangeSetRecord = { ...record, status: 'expired', updatedAt: new Date() };
      await this.commit(entry, expired, req.event({ kind: 'expired', from: record.status }, copyRecord(record)));
      return { ok: false, reason: 'expired' };
    }
    if (record.hash === undefined) return { ok: false, reason: 'not_executable' };
    if (record.hash !== req.expectedHash) return { ok: false, reason: 'hash_mismatch' };
    if (record.status !== 'prepared' && record.status !== 'approved') return { ok: false, reason: 'not_executable' };
    if (record.status === 'approved' && !approvalsCover(record, entry.approvals, req.expectedHash)) {
      return { ok: false, reason: 'not_approved' };
    }
    if (req.limits !== undefined) {
      const since = new Date(req.now.getTime() - DAY_MS);
      const limit = evaluateLimits(req.limits, record.stats.included, this.usageOf(record.requester, since));
      if (limit !== undefined) {
        await this.audit.append(req.event({ kind: 'limit_denied', limit, role: req.limits.role }, copyRecord(record)));
        return { ok: false, reason: 'limit_exceeded', limit };
      }
    }
    const executing: ChangeSetRecord = {
      ...record,
      status: 'executing',
      updatedAt: new Date(),
      ...(req.submission !== undefined && record.status === 'prepared' ? { submission: structuredClone(req.submission) } : {}),
      executionRequest: { ...structuredClone(req.request), startedAt: copyDate(req.now) },
    };
    await this.commit(entry, executing, req.event({ kind: 'executing', from: record.status }, copyRecord(record)));
    this.outbox.enqueue(req.changesetId, req.notifications ?? [], req.now);
    return { ok: true, changeset: copyRecord(executing) };
  }

  requestCancel(
    changesetId: string,
    cancel: CancelRequest,
  ): Promise<{ ok: true; changeset: ChangeSetRecord } | { ok: false; status?: ChangeSetStatus }> {
    const entry = this.entries.get(changesetId);
    if (entry === undefined) return Promise.resolve({ ok: false });
    if (entry.record.status !== 'executing') return Promise.resolve({ ok: false, status: entry.record.status });
    // First request wins.
    if (entry.record.cancelRequest === undefined) {
      entry.record = { ...entry.record, cancelRequest: structuredClone(cancel), updatedAt: new Date() };
    }
    return Promise.resolve({ ok: true, changeset: copyRecord(entry.record) });
  }

  usage(requester: string, since: Date): Promise<ExecutionUsage> {
    return Promise.resolve(this.usageOf(requester, since));
  }

  claimBatch(changesetId: string, batchNo: number, attempt: number, size: number): Promise<ClaimResult> {
    if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH) {
      return Promise.reject(new Error(`batch size must be between 1 and ${MAX_BATCH}`));
    }
    const entry = this.entries.get(changesetId);
    const batches = this.batches.get(changesetId) ?? new Map<number, Batch>();
    const row = batches.get(batchNo);
    if (row === undefined) {
      if (entry === undefined) return Promise.resolve({ kind: 'empty' });
      // No batch is claimed once the change-set left executing.
      if (entry.record.status !== 'executing') return Promise.resolve({ kind: 'fenced' });
      // Continue after the last target of the highest existing batch.
      const highest = this.highestBatch.get(changesetId);
      const after = highest === undefined ? undefined : batches.get(highest)?.lastTarget;
      const items = [...entry.items.values()]
        .filter((i) => i.status === 'pending' && (after === undefined || compareTargetIds(i.targetId, after) > 0))
        .sort((a, b) => compareTargetIds(a.targetId, b.targetId))
        .slice(0, size);
      const last = items[items.length - 1];
      if (last === undefined) return Promise.resolve({ kind: 'empty' });
      const created: Batch = {
        attempt,
        state: 'open',
        targetIds: items.map((i) => i.targetId),
        lastTarget: last.targetId,
        counts: NO_COUNTS,
      };
      batches.set(batchNo, created);
      this.batches.set(changesetId, batches);
      if (highest === undefined || batchNo > highest) this.highestBatch.set(changesetId, batchNo);
      return Promise.resolve(claimed(changesetId, batchNo, created, entry));
    }
    if (row.state === 'done') return Promise.resolve({ kind: 'done', counts: { ...row.counts } });
    if (row.attempt >= attempt || entry?.record.status !== 'executing') return Promise.resolve({ kind: 'fenced' });
    row.attempt = attempt;
    return Promise.resolve(claimed(changesetId, batchNo, row, entry));
  }

  recordSubmission(changesetId: string, batchNo: number, attempt: number, submission: BatchSubmission): Promise<boolean> {
    const row = this.batches.get(changesetId)?.get(batchNo);
    if (row?.attempt !== attempt || row.state !== 'open') return Promise.resolve(false);
    row.submission = structuredClone(submission);
    return Promise.resolve(true);
  }

  async completeBatch(
    changesetId: string,
    batchNo: number,
    attempt: number,
    outcomes: readonly ItemOutcome[],
    audit: AuditEventInput,
  ): Promise<{ ok: true; counts: BatchCounts } | { ok: false }> {
    const entry = this.entries.get(changesetId);
    const row = this.batches.get(changesetId)?.get(batchNo);
    if (entry === undefined || row?.attempt !== attempt || row.state !== 'open') return { ok: false };
    if (entry.record.status !== 'executing') throw new Error('batch outcomes rejected: change-set is not executing');
    // The first outcome per target of the batch wins; only pending items change and count.
    // Check and apply synchronously, undo if the audit append fails.
    const inBatch = new Set(row.targetIds);
    const first = new Map<string, ItemOutcome>();
    for (const o of outcomes) if (inBatch.has(o.targetId) && !first.has(o.targetId)) first.set(o.targetId, o);
    const replaced = new Map<string, ChangeItemRecord>();
    const counts: { -readonly [K in keyof BatchCounts]: number } = { written: 0, failed: 0, skipped: 0 };
    for (const o of first.values()) {
      const current = entry.items.get(o.targetId);
      if (current?.status !== 'pending') continue;
      replaced.set(o.targetId, current);
      entry.items.set(o.targetId, { ...current, status: o.status, ...(o.error === undefined ? {} : { error: o.error }) });
      counts[o.status] += 1;
    }
    const beforeBatch = entry.record;
    entry.record = { ...entry.record, stats: computeStats(entry.items), updatedAt: new Date() };
    row.state = 'done';
    row.counts = counts;
    try {
      await this.audit.append(audit);
    } catch (error) {
      for (const [targetId, item] of replaced) entry.items.set(targetId, item);
      entry.record = beforeBatch;
      row.state = 'open';
      row.counts = NO_COUNTS;
      throw error;
    }
    return { ok: true, counts: { ...counts } };
  }

  /** Applies `next` synchronously, then appends `audit`; undoes the change if the append fails. */
  private async commit(entry: Entry, next: ChangeSetRecord, ...audit: AuditEventInput[]): Promise<void> {
    const previous = entry.record;
    entry.record = next;
    try {
      for (const event of audit) await this.audit.append(event);
    } catch (error) {
      if (entry.record === next) entry.record = previous;
      throw error;
    }
  }

  private usageOf(requester: string, since: Date): ExecutionUsage {
    let recordsSince = 0;
    let executing = 0;
    for (const { record } of this.entries.values()) {
      if (record.requester !== requester) continue;
      const started = record.executionRequest?.startedAt;
      if (started !== undefined && started.getTime() >= since.getTime()) recordsSince += record.stats.included;
      if (record.status === 'executing') executing += 1;
    }
    return { recordsSince, executing };
  }
}

function claimed(changesetId: string, batchNo: number, row: Batch, entry: Entry): ClaimResult {
  const batch: BatchRecord = {
    changesetId,
    batchNo,
    attempt: row.attempt,
    targetIds: [...row.targetIds],
    ...(row.submission === undefined ? {} : { submission: structuredClone(row.submission) }),
  };
  const items = row.targetIds.flatMap((t) => {
    const it = entry.items.get(t);
    return it === undefined ? [] : [copyItem(it)];
  });
  return { kind: 'claimed', batch, items };
}

/** SEC-9: every plan step of the current round holds an `approved` row for this hash. */
function approvalsCover(record: ChangeSetRecord, approvals: readonly ApprovalRecord[], hash: string): boolean {
  const plan = record.approvalPlan;
  // Fail closed: a plan without steps covers nothing (as in PostgreSQL).
  if (plan === undefined || plan.steps.length === 0) return false;
  return plan.steps.every((_, i) =>
    approvals.some((a) => a.round === record.approvalRound && a.step === i + 1 && a.decision === 'approved' && a.hash === hash),
  );
}

const OUTCOME_STATUSES: ReadonlySet<ChangeSetStatus> = new Set<ChangeSetStatus>(['executing', 'rolling_back']);

function isRequesterExclusion(it: ChangeItemRecord): boolean {
  return it.status === 'excluded' && it.reason === 'requester';
}

/** CS-5 copy rules: exclude applies to pending items only, include to requester exclusions only; exclude wins. */
function derivedItem(it: ChangeItemRecord, exclude: ReadonlySet<string>, include: ReadonlySet<string>): ChangeItemRecord {
  const base = { targetId: it.targetId, before: structuredClone(it.before), after: structuredClone(it.after) };
  if (exclude.has(it.targetId) && it.status === 'pending') return { ...base, status: 'excluded', reason: 'requester' };
  if (include.has(it.targetId) && !exclude.has(it.targetId) && isRequesterExclusion(it)) return { ...base, status: 'pending' };
  return { ...base, status: it.status, ...(it.reason === undefined ? {} : { reason: it.reason }) };
}

function computeStats(items: ReadonlyMap<string, ChangeItemRecord>): ChangeSetStats {
  const excluded: Partial<Record<ExclusionReason, number>> = {};
  let included = 0;
  let written = 0;
  let failed = 0;
  let skipped = 0;
  for (const it of items.values()) {
    if (it.status === 'excluded') {
      if (it.reason !== undefined) excluded[it.reason] = (excluded[it.reason] ?? 0) + 1;
      continue;
    }
    included += 1;
    if (it.status === 'written') written += 1;
    else if (it.status === 'failed') failed += 1;
    else if (it.status === 'skipped') skipped += 1;
  }
  return { total: items.size, included, excluded, written, failed, skipped };
}
