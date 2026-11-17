import type { ManifestDefinition, OperationDefinition } from '../policy-model.js';
import { canonicalJson } from './canonical.js';
import { inScope, touchedFields } from './items.js';
import type { ChangeItemRecord, ChangeSetRecord } from './model.js';
import type { BatchContext, ChangeWriter, ItemOutcome, PlanEntry, ReadPage, UpstreamReader } from './ports.js';
import { resolveTemplates } from './prepare.js';

export type WriteOutcomeCode =
  | 'already_applied'
  | 'drift'
  | 'gone'
  | 'upstream_rejected'
  | 'upstream_failed'
  | 'upstream_retriable'
  | 'no_outcome'
  | 'write_mode_unsupported';

export type WriteClassification =
  | { readonly action: 'write' }
  | {
      readonly action: 'outcome';
      readonly status: 'written' | 'skipped';
      readonly error: 'already_applied' | 'drift' | 'gone';
    };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Decide, from a fresh read, whether an item may be written (CS-7, NFR-2).
 * Rules in order: missing or out of scope is gone; every touched field already
 * equals `after` is already applied; every touched field still equals `before`
 * is a write; anything else is drift. Absent and null are the same value;
 * comparison is canonical JSON, so object key order is irrelevant.
 */
export function classifyForWrite(input: {
  readonly manifest: ManifestDefinition;
  readonly args: Readonly<Record<string, unknown>>;
  readonly item: Pick<ChangeItemRecord, 'before' | 'after'>;
  readonly current: Readonly<Record<string, unknown>> | undefined;
}): WriteClassification {
  const { manifest, args, item, current } = input;
  if (current === undefined || !inScope(manifest, args, current)) {
    return { action: 'outcome', status: 'skipped', error: 'gone' };
  }
  const fields = touchedFields(manifest, args);
  const before = isRecord(item.before) ? item.before : {};
  const after = isRecord(item.after) ? item.after : {};
  const equals = (expected: Readonly<Record<string, unknown>>): boolean =>
    fields.every((f) => canonicalJson(current[f] ?? null) === canonicalJson(expected[f] ?? null));
  if (equals(after)) return { action: 'outcome', status: 'written', error: 'already_applied' };
  if (equals(before)) return { action: 'write' };
  return { action: 'outcome', status: 'skipped', error: 'drift' };
}

/** Per-item state of an upstream bulk batch (core port of the SDK's `BulkItemState`). */
export type BulkItemState = 'ok' | 'failed' | 'retriable' | 'open';

/** Bulk write port; the worker binds it to the connection's `WriteAdapter` (OPS-6). */
export interface BulkWriter {
  submit(
    records: readonly Readonly<Record<string, unknown>>[],
  ): Promise<{ ok: true; batchId: string } | { ok: false; code: string; retriable: boolean }>;
  status(
    batchId: string,
  ): Promise<
    | { ok: true; items: readonly { index: number; state: BulkItemState }[] }
    | { ok: false; code: string; retriable: boolean }
  >;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const POLL_INITIAL_MS = 1000;
export const POLL_FACTOR = 1.5;
export const POLL_MAX_MS = 5000;
export const POLL_GIVE_UP_MS = 600_000;

export type RetryableWriteCode = 'read_failed' | 'incomplete_read' | 'submit_failed' | 'status_failed' | 'poll_timeout';

/** The batch was interrupted and the activity retries it (EXE-4). The message never carries upstream text (SEC-3). */
export class RetryableWriteError extends Error {
  constructor(readonly code: RetryableWriteCode) {
    super(`batch write interrupted: ${code}`);
    this.name = 'RetryableWriteError';
  }
}

export interface ManifestBatchWriterDeps {
  readonly operation: OperationDefinition & { readonly manifest: ManifestDefinition };
  /** `fields_arg` of `manifest.readBefore.operation`; undefined when that read takes no field list. */
  readonly readFieldsArg: string | undefined;
  readonly readerFor: (changeset: ChangeSetRecord) => UpstreamReader;
  readonly bulkFor: (changeset: ChangeSetRecord) => BulkWriter;
  readonly clock: Clock;
}

type WriteInput = Parameters<ChangeWriter['writeBatch']>[0];
type Current = ReadonlyMap<string, Readonly<Record<string, unknown>>>;

/** Higher wins when an index appears more than once in a status answer. */
const STATE_RANK: Readonly<Record<BulkItemState, number>> = { ok: 0, open: 1, retriable: 2, failed: 3 };

/**
 * Writes one batch of a manifest change-set through an upstream bulk API (design part 2 §4):
 * read current state, classify (CS-7), submit the items still at `before`, record the submission
 * before polling (EXE-4), poll, map states by index, and verify the `ok` items with one more read.
 */
export class ManifestBatchWriter implements ChangeWriter {
  private readonly manifest: ManifestDefinition;

  constructor(private readonly deps: ManifestBatchWriterDeps) {
    this.manifest = deps.operation.manifest;
  }

  async writeBatch(input: WriteInput): Promise<readonly ItemOutcome[]> {
    const { changeset, items, batch } = input;
    const touched = touchedFields(this.manifest, changeset.args);
    // With nothing to compare every item would look already applied; fail them instead.
    if (touched.length === 0) {
      return items.map((i): ItemOutcome => ({ targetId: i.targetId, status: 'failed', error: 'write_mode_unsupported' }));
    }
    const reader = this.deps.readerFor(changeset);
    const { plan, records } = await this.classifyBatch(changeset, items, touched, reader);
    if (records.length === 0) return outcomesOf(plan, new Map());

    const bulk = this.deps.bulkFor(changeset);
    const batchId = await this.submit(bulk, records);
    if (batchId === undefined) {
      const rejected = new Map<string, ItemOutcome>();
      for (const e of plan) {
        if (e.action === 'write') {
          rejected.set(e.targetId, { targetId: e.targetId, status: 'failed', error: 'upstream_rejected' });
        }
      }
      return outcomesOf(plan, rejected);
    }
    // A fenced attempt throws BatchFenced here; it propagates and nothing is polled (EXE-4).
    await batch.recordSubmission({ upstreamBatchId: batchId, plan });
    const polled = await this.poll(bulk, batchId, records.length, batch);
    return this.finish(changeset, plan, polled, items, reader);
  }

  private async classifyBatch(
    changeset: ChangeSetRecord,
    items: readonly ChangeItemRecord[],
    touched: readonly string[],
    reader: UpstreamReader,
  ): Promise<{ plan: PlanEntry[]; records: Record<string, unknown>[] }> {
    const m = this.manifest;
    const carry = m.write?.carryFields ?? [];
    const fields = [...new Set([m.idField, ...touched, ...Object.values(m.scopeArgs), ...carry])];
    const current = await this.read(
      changeset,
      reader,
      items.map((i) => i.targetId),
      fields,
    );
    const plan: PlanEntry[] = [];
    const records: Record<string, unknown>[] = [];
    for (const item of items) {
      const cur = current.get(item.targetId);
      const c = safeClassify(m, changeset.args, item, cur);
      // `write` is only answered for a found record, so `cur` is defined on that path.
      if (c.action === 'outcome' || cur === undefined) {
        const o = c.action === 'outcome' ? c : ({ status: 'skipped', error: 'gone' } as const);
        plan.push({ targetId: item.targetId, action: 'outcome', status: o.status, error: o.error });
        continue;
      }
      plan.push({ targetId: item.targetId, action: 'write' });
      const after = isRecord(item.after) ? item.after : {};
      const record: Record<string, unknown> = { [m.idField]: cur[m.idField] };
      for (const f of carry) if (Object.hasOwn(cur, f)) record[f] = cur[f];
      for (const f of touched) record[f] = after[f] ?? null;
      records.push(record);
    }
    return { plan, records };
  }

  /** Answers the upstream batch ID, or undefined when the upstream rejected the batch. */
  private async submit(bulk: BulkWriter, records: readonly Record<string, unknown>[]): Promise<string | undefined> {
    const res = await bulk.submit(records);
    if (res.ok) return res.batchId;
    if (res.code === 'rejected') return undefined;
    throw new RetryableWriteError('submit_failed');
  }

  /** Polls until no submitted index is open; answers the worst state per index in 0..writeCount-1. */
  private async poll(
    bulk: BulkWriter,
    batchId: string,
    writeCount: number,
    batch: BatchContext,
  ): Promise<Map<number, BulkItemState>> {
    for (let round = 0; ; round++) {
      batch.heartbeat();
      await this.deps.clock.sleep(Math.min(POLL_MAX_MS, POLL_INITIAL_MS * POLL_FACTOR ** round));
      const res = await bulk.status(batchId);
      if (!res.ok) throw new RetryableWriteError('status_failed');
      const states = new Map<number, BulkItemState>();
      for (const { index, state } of res.items) {
        if (!Number.isInteger(index) || index < 0 || index >= writeCount) continue;
        const prev = states.get(index);
        if (prev === undefined || STATE_RANK[state] > STATE_RANK[prev]) states.set(index, state);
      }
      if (![...states.values()].includes('open')) return states;
    }
  }

  /** Maps polled states onto the plan's write entries (index = position among them) and verifies the `ok` ones. */
  private async finish(
    changeset: ChangeSetRecord,
    plan: readonly PlanEntry[],
    polled: ReadonlyMap<number, BulkItemState>,
    items: readonly ChangeItemRecord[],
    reader: UpstreamReader,
  ): Promise<readonly ItemOutcome[]> {
    const decided = new Map<string, ItemOutcome>();
    const candidates: string[] = [];
    let index = 0;
    for (const e of plan) {
      if (e.action !== 'write') continue;
      const state = polled.get(index++);
      if (state === 'ok') {
        candidates.push(e.targetId);
        continue;
      }
      const error = state === 'failed' ? 'upstream_failed' : state === 'retriable' ? 'upstream_retriable' : 'no_outcome';
      decided.set(e.targetId, { targetId: e.targetId, status: 'failed', error });
    }
    if (candidates.length > 0) {
      const m = this.manifest;
      const touched = touchedFields(m, changeset.args);
      const current = await this.read(changeset, reader, candidates, [...new Set([m.idField, ...touched])]);
      const afterOf = new Map(items.map((i) => [i.targetId, isRecord(i.after) ? i.after : {}]));
      for (const targetId of candidates) {
        const cur = current.get(targetId);
        if (cur === undefined) {
          decided.set(targetId, { targetId, status: 'skipped', error: 'gone' });
          continue;
        }
        const written = safeEquals(touched, cur, afterOf.get(targetId) ?? {});
        decided.set(targetId, written ? { targetId, status: 'written' } : { targetId, status: 'skipped', error: 'drift' });
      }
    }
    return outcomesOf(plan, decided);
  }

  /** One `read_before` read of `targetIds`, indexed by id (first record wins). */
  private async read(
    changeset: ChangeSetRecord,
    reader: UpstreamReader,
    targetIds: readonly string[],
    fields: readonly string[],
  ): Promise<Current> {
    const rb = this.manifest.readBefore;
    const args: Record<string, unknown> = { ...resolveTemplates(rb.args, changeset.args), [rb.idsArg]: [...targetIds] };
    if (this.deps.readFieldsArg !== undefined) args[this.deps.readFieldsArg] = [...fields];
    const page: ReadPage = await reader.read(rb.operation, args);
    if (!page.ok) throw new RetryableWriteError('read_failed');
    if (page.truncated) throw new RetryableWriteError('incomplete_read');
    const byId = new Map<string, Readonly<Record<string, unknown>>>();
    for (const record of page.items) {
      const id = record[this.manifest.idField];
      if (typeof id !== 'string' && typeof id !== 'number') continue;
      const key = String(id);
      if (!byId.has(key)) byId.set(key, record);
    }
    return byId;
  }
}

/** A value canonical JSON cannot encode (NaN, Date, ...) is drift, never a thrown batch (CS-7). */
function safeClassify(
  manifest: ManifestDefinition,
  args: Readonly<Record<string, unknown>>,
  item: ChangeItemRecord,
  current: Readonly<Record<string, unknown>> | undefined,
): WriteClassification {
  try {
    return classifyForWrite({ manifest, args, item, current });
  } catch (err) {
    if (err instanceof TypeError) return { action: 'outcome', status: 'skipped', error: 'drift' };
    throw err;
  }
}

function safeEquals(
  fields: readonly string[],
  current: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  try {
    return fields.every((f) => canonicalJson(current[f] ?? null) === canonicalJson(expected[f] ?? null));
  } catch (err) {
    if (err instanceof TypeError) return false;
    throw err;
  }
}

/** Outcomes in plan order: a decided outcome, else the plan's own classification. */
function outcomesOf(plan: readonly PlanEntry[], decided: ReadonlyMap<string, ItemOutcome>): ItemOutcome[] {
  return plan.map((e): ItemOutcome => {
    const d = decided.get(e.targetId);
    if (d !== undefined) return d;
    if (e.action === 'outcome') return { targetId: e.targetId, status: e.status, error: e.error };
    // Unreachable: every write entry is decided before this point; fail closed anyway.
    return { targetId: e.targetId, status: 'failed', error: 'no_outcome' };
  });
}

/** The writer for an operation whose connection has no supported write mode (OPS-6). */
export class UnsupportedWriter implements ChangeWriter {
  writeBatch(input: WriteInput): Promise<readonly ItemOutcome[]> {
    return Promise.resolve(
      input.items.map((i): ItemOutcome => ({ targetId: i.targetId, status: 'failed', error: 'write_mode_unsupported' })),
    );
  }
}
