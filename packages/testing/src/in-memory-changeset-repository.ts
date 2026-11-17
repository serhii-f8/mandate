import type {
  AuditEventInput,
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
import { compareTargetIds, EMPTY_STATS } from '@aiops/core';
import { InMemoryAuditLog } from './in-memory-audit-log.js';

const MAX_PAGE = 500;

interface Entry {
  record: ChangeSetRecord;
  readonly items: Map<string, ChangeItemRecord>;
}

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
    const previous = entry.record;
    // Check and apply synchronously (compare-and-set); undo if the audit append fails.
    entry.record =
      outcome.status === 'prepared'
        ? {
            ...entry.record,
            status: 'prepared',
            hash: outcome.hash,
            stats: structuredClone(outcome.stats),
            preparedAt: copyDate(outcome.preparedAt),
          }
        : { ...entry.record, status: 'failed', errorCode: outcome.errorCode };
    const next = entry.record;
    try {
      await this.audit.append(audit);
    } catch (error) {
      if (entry.record === next) entry.record = previous;
      throw error;
    }
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
    const previous = entry.record;
    // Check and apply synchronously (compare-and-set); undo if the audit append fails.
    entry.record = {
      ...entry.record,
      status: to,
      ...(extra?.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
    };
    const next = entry.record;
    try {
      await this.audit.append(audit);
    } catch (error) {
      if (entry.record === next) entry.record = previous;
      throw error;
    }
    return copyRecord(next);
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
    entry.record = { ...entry.record, stats: computeStats(entry.items) };
    return Promise.resolve();
  }
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
