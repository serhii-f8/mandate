// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ManifestDefinition, OperationDefinition } from '../policy-model.js';
import { CanonicalJsonError, canonicalJson } from './canonical.js';
import { itemFields, manifestAction } from './fields.js';
import { inScope, touchedFields } from './items.js';
import type { ChangeItemRecord, ChangeSetRecord } from './model.js';
import type { BatchContext, ChangeWriter, ItemOutcome, PlanEntry, ReadPage, UpstreamReader } from './ports.js';
import { resolveTemplates } from './prepare.js';

export type WriteOutcomeCode =
  | 'already_applied'
  | 'already_restored'
  | 'drift'
  | 'gone'
  | 'upstream_rejected'
  | 'upstream_failed'
  | 'upstream_retriable'
  | 'no_outcome'
  | 'write_mode_unsupported'
  | 'upstream_changed'
  | 'upstream_unavailable'
  | 'egress_denied'
  | 'credential_missing'
  | 'credential_unusable'
  /** The upstream answered `ok`, but a create is still absent or a delete still present (CS-7). */
  | 'not_applied';

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
 * Decide, from a fresh read, whether an item may be written (CS-7, NFR-2). A side that is `null`
 * stands for "no record" (a create's `before`, a delete's `after`, ADR 0071); the record is present
 * when it was read and is in scope. A side matches when it is `null` and nothing was read, or the
 * record is present and every field the item touches (`itemFields`) equals that side.
 * Rules in order: matches `after` is already applied; matches `before` is a write; neither side
 * `null` and the record not present is gone; anything else is drift (so a create never overwrites a
 * record that appeared, and a delete never removes one changed since approval). Absent and null are
 * the same value; comparison is canonical JSON, so object key order is irrelevant.
 */
export function classifyForWrite(input: {
  readonly manifest: ManifestDefinition;
  readonly args: Readonly<Record<string, unknown>>;
  readonly item: Pick<ChangeItemRecord, 'before' | 'after'>;
  readonly current: Readonly<Record<string, unknown>> | undefined;
}): WriteClassification {
  const { manifest, args, item, current } = input;
  const present = current !== undefined && inScope(manifest, args, current);
  const fields = itemFields(manifest, item);
  const matches = (side: unknown): boolean => {
    if (side === null) return current === undefined;
    if (!present) return false;
    const expected = isRecord(side) ? side : {};
    return fields.every((f) => canonicalJson(current[f] ?? null) === canonicalJson(expected[f] ?? null));
  };
  if (matches(item.after)) return { action: 'outcome', status: 'written', error: 'already_applied' };
  if (matches(item.before)) return { action: 'write' };
  if (item.before !== null && item.after !== null && !present) return { action: 'outcome', status: 'skipped', error: 'gone' };
  return { action: 'outcome', status: 'skipped', error: 'drift' };
}

export type RollbackClassification =
  | { readonly action: 'write' }
  | {
      readonly action: 'outcome';
      readonly status: 'written' | 'skipped';
      readonly error: 'already_restored' | 'drift' | 'gone';
    };

/** CS-7 on the way back: classifyForWrite with `before` and `after` swapped; `already_applied` reads `already_restored`. */
export function classifyForRollback(input: Parameters<typeof classifyForWrite>[0]): RollbackClassification {
  const c = classifyForWrite({ ...input, item: swapped(input.item) });
  if (c.action === 'write') return c;
  if (c.error === 'already_applied') return { action: 'outcome', status: c.status, error: 'already_restored' };
  return { action: 'outcome', status: c.status, error: c.error };
}

function swapped<T extends Pick<ChangeItemRecord, 'before' | 'after'>>(item: T): T {
  return { ...item, before: item.after, after: item.before };
}

/** Which way a batch is written: `forward` applies `after`; `reverse` restores `before` (EXE-8). */
export type WriteDirection = 'forward' | 'reverse';

/** Per-item state of an upstream bulk batch (core port of the SDK's `BulkItemState`). */
export type BulkItemState = 'ok' | 'failed' | 'retriable' | 'open';

/** Bulk write port; the worker binds it to the connection's `WriteAdapter` (OPS-6). */
export interface BulkWriter {
  submit(
    records: readonly Readonly<Record<string, unknown>>[],
  ): Promise<{ ok: true; batchId: string } | { ok: false; code: string; retriable: boolean }>;
  /**
   * `keys`: the target IDs of the plan's `write` entries, in plan order, for an upstream that
   * reports per-item state by key instead of index (`bulk.status.key`).
   * `status` on a failure: the HTTP status of an `http_status` failure (a number, never upstream text).
   */
  status(
    batchId: string,
    keys: readonly string[],
  ): Promise<
    | { ok: true; items: readonly { index: number; state: BulkItemState }[] }
    | { ok: false; code: string; retriable: boolean; status?: number }
  >;
}

/** Per-record answer of a direct writer. */
export type DirectRecordState = 'ok' | 'failed' | 'retriable';

/** Per-record and code writers (OPS-5, OPS-6): one answer per record, in order; nothing to poll. */
export interface DirectWriter {
  write(
    records: readonly Readonly<Record<string, unknown>>[],
    heartbeat: () => void,
  ): Promise<{ ok: true; states: readonly DirectRecordState[] } | { ok: false; code: string; retriable: boolean }>;
}

/**
 * A status failure the retry of the batch may clear although the port calls it non-retriable: the
 * credential (a missing, unusable or expired token: 401, 403) is replaced while the upstream may
 * still apply the batch, so it is not given up as `no_outcome` (EXE-4).
 */
function authenticationFailure(failure: { readonly code: string; readonly status?: number }): boolean {
  if (failure.code === 'credential_missing' || failure.code === 'credential_unusable') return true;
  return failure.code === 'http_status' && (failure.status === 401 || failure.status === 403);
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const POLL_INITIAL_MS = 1000;
export const POLL_FACTOR = 1.5;
export const POLL_MAX_MS = 5000;
export const POLL_GIVE_UP_MS = 600_000;

export type RetryableWriteCode =
  | 'read_failed'
  | 'incomplete_read'
  | 'submit_failed'
  | 'status_failed'
  | 'poll_timeout'
  | 'write_failed'
  | 'write_retriable';

/** The batch was interrupted and the activity retries it (EXE-4). The message never carries upstream text (SEC-3). */
export class RetryableWriteError extends Error {
  constructor(readonly code: RetryableWriteCode) {
    super(`batch write interrupted: ${code}`);
    this.name = 'RetryableWriteError';
  }
}

interface ManifestBatchWriterBase {
  readonly operation: OperationDefinition & { readonly manifest: ManifestDefinition };
  /** `fields_arg` of `manifest.readBefore.operation`; undefined when that read takes no field list. */
  readonly readFieldsArg: string | undefined;
  readonly readerFor: (changeset: ChangeSetRecord) => UpstreamReader;
  readonly clock: Clock;
  /** `reverse` writes the stored `before` back over the stored `after` (rollback, EXE-8). Default `forward`. */
  readonly direction?: WriteDirection;
}

/** Exactly one write mode: `bulkFor` (submit, record, poll) or `directFor` (one answer per record). */
export type ManifestBatchWriterDeps = ManifestBatchWriterBase &
  (
    | { readonly bulkFor: (changeset: ChangeSetRecord) => BulkWriter; readonly directFor?: never }
    | { readonly directFor: (changeset: ChangeSetRecord) => DirectWriter; readonly bulkFor?: never }
  );

type WriteInput = Parameters<ChangeWriter['writeBatch']>[0];
type Current = ReadonlyMap<string, Readonly<Record<string, unknown>>>;

/** Higher wins when an index appears more than once in a status answer. */
const STATE_RANK: Readonly<Record<BulkItemState, number>> = { ok: 0, open: 1, retriable: 2, failed: 3 };

/**
 * Writes one batch of a manifest change-set (design part 2 §4) in one of two modes. Both read
 * current state, classify (CS-7), write only the items still at `before`, and verify the `ok`
 * items with one more read.
 * - Bulk (`bulkFor`): submit, record the submission before polling (EXE-4), poll with the to-write
 *   target IDs as keys, and map states by index.
 * - Direct (`directFor`, per-record and code writers, OPS-5 and OPS-6): one answer per record and
 *   nothing to poll, so no submission is recorded. A `retriable` record state throws
 *   `write_retriable` and a retriable answer throws `write_failed`; the retry re-reads, so records
 *   already written become `already_applied` (NFR-2). A recorded submission found in direct mode
 *   (the mode changed under a running batch) ends every to-write item `no_outcome` unwritten.
 */
export class ManifestBatchWriter implements ChangeWriter {
  private readonly manifest: ManifestDefinition;

  constructor(private readonly deps: ManifestBatchWriterDeps) {
    this.manifest = deps.operation.manifest;
  }

  /**
   * Reverse (EXE-8, ruling R9): every item's `before` and `after` are swapped first, so the forward
   * algorithm below reads, classifies, submits, records, polls and verifies toward the stored
   * `before`; an `already_applied` outcome then reads `already_restored`.
   */
  async writeBatch(input: WriteInput): Promise<readonly ItemOutcome[]> {
    if (this.deps.direction !== 'reverse') return this.writeForward(input);
    const outcomes = await this.writeForward({ ...input, items: input.items.map((i) => swapped(i)) });
    return outcomes.map((o): ItemOutcome => (o.error === 'already_applied' ? { ...o, error: 'already_restored' } : o));
  }

  /**
   * With no field to compare an item would look already applied, so it fails `write_mode_unsupported`
   * instead: every item when an update call touches no field, else each item that touches none (CS-7).
   * The call-wide rule is for `update` only: a delete call has no values (and the rollback of a create
   * or delete runs with the arguments of the other action), so there each item's own fields decide.
   * The other items are written; outcomes keep the input order.
   */
  private async writeForward(input: WriteInput): Promise<readonly ItemOutcome[]> {
    const { changeset, items, batch } = input;
    const unsupported = (i: ChangeItemRecord): ItemOutcome => ({
      targetId: i.targetId,
      status: 'failed',
      error: 'write_mode_unsupported',
    });
    const supported = items.filter((i) => itemFields(this.manifest, i).length > 0);
    const callTouchesNothing = manifestAction(this.manifest) === 'update' && touchedFields(this.manifest, changeset.args).length === 0;
    // Resume (EXE-4) keeps its order: a recorded submission is polled before anything else is decided.
    if (batch.submission === undefined && (callTouchesNothing || supported.length === 0)) {
      return items.map(unsupported);
    }
    if (supported.length === items.length) return this.writeSupported(input);
    const outcomes = new Map((await this.writeSupported({ ...input, items: supported })).map((o) => [o.targetId, o]));
    return items.map((i) => outcomes.get(i.targetId) ?? unsupported(i));
  }

  /** Writes a batch whose items each touch at least one field (or resumes its recorded submission). */
  private async writeSupported(input: WriteInput): Promise<readonly ItemOutcome[]> {
    const { changeset, items, batch } = input;
    // Resume (EXE-4): a recorded submission is never resubmitted and nothing is read before polling.
    if (batch.submission !== undefined) {
      const { upstreamBatchId, plan } = batch.submission;
      if (this.deps.bulkFor === undefined) return outcomesOf(plan, new Map(), 'no_outcome');
      const polled = await this.poll(this.deps.bulkFor(changeset), upstreamBatchId, writeKeys(plan), batch);
      return this.finish(changeset, plan, polled, items, this.deps.readerFor(changeset));
    }
    const reader = this.deps.readerFor(changeset);
    const { plan, records } = await this.classifyBatch(changeset, items, reader);
    if (records.length === 0) return outcomesOf(plan, new Map());

    if (this.deps.directFor !== undefined) {
      const polled = await this.writeDirect(this.deps.directFor(changeset), records, batch);
      if (!polled.ok) return outcomesOf(plan, new Map(), polled.error);
      return this.finish(changeset, plan, polled.states, items, reader);
    }

    const bulk = this.deps.bulkFor(changeset);
    const submitted = await this.submit(bulk, records);
    if (!submitted.ok) return outcomesOf(plan, new Map(), submitted.error);
    const batchId = submitted.batchId;
    // A fenced attempt throws BatchFenced here; it propagates and nothing is polled (EXE-4).
    await batch.recordSubmission({ upstreamBatchId: batchId, plan });
    const polled = await this.poll(bulk, batchId, writeKeys(plan), batch);
    return this.finish(changeset, plan, polled, items, reader);
  }

  /**
   * One direct write of the to-write records; answers their states by position. A retriable answer
   * or any `retriable` state throws: the retry re-reads, so what was written reads `already_applied`
   * and only the rest is sent again (NFR-2). That also covers records after a `retriable` one that
   * the writer never started (the answer is shorter than the records). A non-retriable answer ends
   * every to-write item: `invalid_response` came with a success status, so the upstream may have
   * applied the records (`no_outcome`); any other was refused or never sent (`upstream_rejected`).
   * A state missing from a shorter answer stays absent from the map and `finish` makes it `no_outcome`.
   */
  private async writeDirect(
    direct: DirectWriter,
    records: readonly Record<string, unknown>[],
    batch: BatchContext,
  ): Promise<{ ok: true; states: Map<number, BulkItemState> } | { ok: false; error: 'no_outcome' | 'upstream_rejected' }> {
    const res = await direct.write(records, () => {
      batch.heartbeat();
    });
    if (!res.ok) {
      if (res.retriable) throw new RetryableWriteError('write_failed');
      return { ok: false, error: res.code === 'invalid_response' ? 'no_outcome' : 'upstream_rejected' };
    }
    if (res.states.includes('retriable')) throw new RetryableWriteError('write_retriable');
    const states = new Map<number, BulkItemState>();
    res.states.forEach((state, index) => {
      if (index < records.length) states.set(index, state);
    });
    return { ok: true, states };
  }

  private async classifyBatch(
    changeset: ChangeSetRecord,
    items: readonly ChangeItemRecord[],
    reader: UpstreamReader,
  ): Promise<{ plan: PlanEntry[]; records: Record<string, unknown>[] }> {
    const m = this.manifest;
    const carry = m.write?.carryFields ?? [];
    const fields = [...new Set([m.idField, ...unionFields(m, items), ...Object.values(m.scopeArgs), ...carry])];
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
      const record = c.action === 'write' ? writeRecord(m, carry, item, cur) : undefined;
      if (c.action === 'outcome' || record === undefined) {
        // `writeRecord` answers for every `write` classification; the fallback only fails closed.
        const o = c.action === 'outcome' ? c : ({ status: 'skipped', error: 'gone' } as const);
        plan.push({ targetId: item.targetId, action: 'outcome', status: o.status, error: o.error });
        continue;
      }
      plan.push({ targetId: item.targetId, action: 'write' });
      records.push(record);
    }
    return { plan, records };
  }

  /**
   * Answers the upstream batch ID, or the outcome of every to-write item when the submit failed for
   * good. Only a retriable failure is retried (`submit_failed`). A non-retriable one is never sent
   * again: `invalid_response` came with a success status, so the upstream may have taken the batch
   * without an ID to poll (`no_outcome`); any other (`rejected`, `mapping`, `egress_denied`,
   * `credential_*`, ...) was refused or never sent (`upstream_rejected`).
   */
  private async submit(
    bulk: BulkWriter,
    records: readonly Record<string, unknown>[],
  ): Promise<{ ok: true; batchId: string } | { ok: false; error: 'no_outcome' | 'upstream_rejected' }> {
    const res = await bulk.submit(records);
    if (res.ok) return res;
    if (res.retriable) throw new RetryableWriteError('submit_failed');
    return { ok: false, error: res.code === 'invalid_response' ? 'no_outcome' : 'upstream_rejected' };
  }

  /**
   * Polls until no submitted index is open; answers the worst state per index in 0..keys.length-1.
   * `keys` are the to-write target IDs in plan order, passed to every status call.
   * One heartbeat per round; waits 1 s growing x1.5 up to 5 s; still open after 10 min throws
   * `poll_timeout` (the retry resumes from the recorded submission). An empty item list counts as
   * still open. A non-retriable status failure (the upstream no longer knows the batch, or answers
   * what cannot be read) answers no states, so every submitted item ends `failed/no_outcome` and
   * nothing is verified (EXE-5); an authentication failure is retried instead (`status_failed`).
   */
  private async poll(
    bulk: BulkWriter,
    batchId: string,
    keys: readonly string[],
    batch: BatchContext,
  ): Promise<Map<number, BulkItemState>> {
    const writeCount = keys.length;
    const clock = this.deps.clock;
    const start = clock.now();
    for (let round = 0; ; round++) {
      batch.heartbeat();
      await clock.sleep(Math.min(POLL_MAX_MS, POLL_INITIAL_MS * POLL_FACTOR ** round));
      const res = await bulk.status(batchId, keys);
      if (!res.ok) {
        if (res.retriable || authenticationFailure(res)) throw new RetryableWriteError('status_failed');
        return new Map();
      }
      const states = new Map<number, BulkItemState>();
      for (const { index, state } of res.items) {
        if (!Number.isInteger(index) || index < 0 || index >= writeCount) continue;
        const prev = states.get(index);
        if (prev === undefined || STATE_RANK[state] > STATE_RANK[prev]) states.set(index, state);
      }
      const open = res.items.length === 0 || [...states.values()].includes('open');
      if (!open) return states;
      if (clock.now() - start >= POLL_GIVE_UP_MS) throw new RetryableWriteError('poll_timeout');
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
      const byId = new Map(items.map((i) => [i.targetId, i]));
      const toVerify = candidates.flatMap((targetId) => byId.get(targetId) ?? []);
      const current = await this.read(changeset, reader, candidates, [...new Set([m.idField, ...unionFields(m, toVerify)])]);
      for (const targetId of candidates) decided.set(targetId, verified(m, targetId, byId.get(targetId), current.get(targetId)));
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

/**
 * The record sent for an item classified `write` (OPS-2, ADR 0071). A create (`before` null):
 * `{ id_field: targetId, ...after }`. A delete (`after` null): `{ id_field }` plus the carry fields of
 * the current record. An update: `{ id_field }`, the carry fields, then the item's fields from `after`.
 * In reverse the swapped item takes the other shape, so a rollback needs nothing more. `undefined`
 * when a delete or an update has no current record (never so for a `write` classification).
 */
function writeRecord(
  m: ManifestDefinition,
  carry: readonly string[],
  item: ChangeItemRecord,
  cur: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (item.before === null) {
    const after = isRecord(item.after) ? item.after : {};
    const record: Record<string, unknown> = { [m.idField]: item.targetId };
    for (const f of itemFields(m, item)) record[f] = after[f] ?? null;
    return record;
  }
  if (cur === undefined) return undefined;
  const record: Record<string, unknown> = { [m.idField]: cur[m.idField] };
  for (const f of carry) if (Object.hasOwn(cur, f)) record[f] = cur[f];
  if (item.after === null) return record;
  const after = isRecord(item.after) ? item.after : {};
  for (const f of itemFields(m, item)) record[f] = after[f] ?? null;
  return record;
}

/**
 * The outcome of an item the upstream answered `ok`, from the verify read (CS-7). A delete (`after`
 * null): absent is written, still present `failed/not_applied`. A create (`before` null): absent is
 * `failed/not_applied`. Otherwise absent is gone, and a present record is written when it equals
 * `after` over the item's fields, else drift (also for an `ok` index with no item).
 */
function verified(
  m: ManifestDefinition,
  targetId: string,
  item: ChangeItemRecord | undefined,
  cur: Readonly<Record<string, unknown>> | undefined,
): ItemOutcome {
  if (item?.after === null) {
    return cur === undefined ? { targetId, status: 'written' } : { targetId, status: 'failed', error: 'not_applied' };
  }
  if (cur === undefined) {
    return item?.before === null ? { targetId, status: 'failed', error: 'not_applied' } : { targetId, status: 'skipped', error: 'gone' };
  }
  const after = item !== undefined && isRecord(item.after) ? item.after : {};
  const written = item !== undefined && safeEquals(itemFields(m, item), cur, after);
  return written ? { targetId, status: 'written' } : { targetId, status: 'skipped', error: 'drift' };
}

/** The fields any of `items` touches, in manifest `fields` order (the read field list of a batch). */
function unionFields(m: ManifestDefinition, items: readonly Pick<ChangeItemRecord, 'before' | 'after'>[]): string[] {
  const touched = new Set(items.flatMap((i) => itemFields(m, i)));
  return m.fields.filter((f) => touched.has(f));
}

/**
 * A value canonical JSON cannot encode (NaN, Date, ...) is drift, never a thrown batch (CS-7).
 * Only `CanonicalJsonError` is caught: any other error is a bug and propagates.
 */
function safeClassify(
  manifest: ManifestDefinition,
  args: Readonly<Record<string, unknown>>,
  item: ChangeItemRecord,
  current: Readonly<Record<string, unknown>> | undefined,
): WriteClassification {
  try {
    return classifyForWrite({ manifest, args, item, current });
  } catch (err) {
    if (err instanceof CanonicalJsonError) return { action: 'outcome', status: 'skipped', error: 'drift' };
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
    if (err instanceof CanonicalJsonError) return false;
    throw err;
  }
}

/** The target IDs of the plan's `write` entries, in plan order (the status keys). */
function writeKeys(plan: readonly PlanEntry[]): string[] {
  return plan.filter((e) => e.action === 'write').map((e) => e.targetId);
}

/**
 * Outcomes in plan order: a decided outcome, else the plan's own classification. An undecided
 * write entry fails with `undecided` (every to-write item ended by one answer); without it, every
 * write entry is decided before this point, and `no_outcome` fails closed anyway.
 */
function outcomesOf(
  plan: readonly PlanEntry[],
  decided: ReadonlyMap<string, ItemOutcome>,
  undecided: 'no_outcome' | 'upstream_rejected' = 'no_outcome',
): ItemOutcome[] {
  return plan.map((e): ItemOutcome => {
    const d = decided.get(e.targetId);
    if (d !== undefined) return d;
    if (e.action === 'outcome') return { targetId: e.targetId, status: e.status, error: e.error };
    return { targetId: e.targetId, status: 'failed', error: undecided };
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
