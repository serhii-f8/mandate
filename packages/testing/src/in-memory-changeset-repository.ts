import type {
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
} from '@aiops/core';
import { compareTargetIds, EMPTY_STATS, evaluateLimits, isExpiryDue } from '@aiops/core';
import { InMemoryAuditLog } from './in-memory-audit-log.js';

const MAX_PAGE = 500;
const MAX_BATCH = 1000;
const DAY_MS = 24 * 3_600_000;
const NO_COUNTS: BatchCounts = Object.freeze({ written: 0, failed: 0, skipped: 0 });

interface Entry {
  record: ChangeSetRecord;
  readonly items: Map<string, ChangeItemRecord>;
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
  /** Largest `appendItems` batch seen (NFR-7 tests). */
  largestAppend = 0;
  /** Largest `itemsPage` limit seen (NFR-7 tests). */
  largestPage = 0;
  private readonly entries = new Map<string, Entry>();
  private readonly batches = new Map<string, Map<number, Batch>>();
  /** Highest batch number per change-set, tracked as batches are created. */
  private readonly highestBatch = new Map<string, number>();

  constructor(audit: InMemoryAuditLog = new InMemoryAuditLog()) {
    this.audit = audit;
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
    };
    // Apply before awaiting the audit append so concurrent callers see the change; undo if the append fails.
    this.entries.set(cs.id, { record, items: new Map() });
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

  async completePreparation(
    changesetId: string,
    outcome:
      | { status: 'prepared'; hash: string; stats: ChangeSetStats; preparedAt: Date }
      | { status: 'failed'; errorCode: string },
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
        : { ...entry.record, status: 'failed', errorCode: outcome.errorCode, updatedAt: new Date() };
    await this.commit(entry, next, audit);
    return copyRecord(next);
  }

  async transition(
    changesetId: string,
    from: readonly ChangeSetStatus[],
    to: ChangeSetStatus,
    audit: AuditEventInput,
    extra?: { errorCode?: string; expiredBefore?: Date },
  ): Promise<ChangeSetRecord | undefined> {
    const entry = this.entries.get(changesetId);
    const expiredBefore = extra?.expiredBefore;
    if (entry === undefined || !from.includes(entry.record.status)) return undefined;
    if (expiredBefore !== undefined && entry.record.expiresAt.getTime() > expiredBefore.getTime()) return undefined;
    // Check and apply synchronously (compare-and-set); undo if the audit append fails.
    const next: ChangeSetRecord = {
      ...entry.record,
      status: to,
      updatedAt: new Date(),
      ...(extra?.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
    };
    await this.commit(entry, next, audit);
    return copyRecord(next);
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
      executionRequest: { ...structuredClone(req.request), startedAt: copyDate(req.now) },
    };
    await this.commit(entry, executing, req.event({ kind: 'executing', from: record.status }, copyRecord(record)));
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
  private async commit(entry: Entry, next: ChangeSetRecord, audit: AuditEventInput): Promise<void> {
    const previous = entry.record;
    entry.record = next;
    try {
      await this.audit.append(audit);
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

const OUTCOME_STATUSES: ReadonlySet<ChangeSetStatus> = new Set<ChangeSetStatus>(['executing', 'rolling_back']);

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
