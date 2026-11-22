// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ManifestDefinition } from '../policy-model.js';
import { failedCheck, type CheckContext } from './checks.js';
import { callRecords, manifestAction } from './fields.js';
import type { ChangeItemRecord, ExclusionReason } from './model.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep JSON equality: object key order is irrelevant, array order matters. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Keys of the values argument, in manifest `fields` order. For a `records_arg` call: the union of the
 * records' fields, in manifest `fields` order (CS-2).
 */
export function touchedFields(manifest: ManifestDefinition, args: Readonly<Record<string, unknown>>): string[] {
  const records = callRecords(manifest, args);
  if (records !== undefined) {
    const all = [...records.values()];
    return manifest.fields.filter((f) => all.some((values) => Object.hasOwn(values, f)));
  }
  return valuesFields(manifest, valuesOf(manifest, args));
}

/** The values object of a `values_arg` call; empty when there is none. */
function valuesOf(manifest: ManifestDefinition, args: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const values = manifest.valuesArg === undefined ? undefined : args[manifest.valuesArg];
  return isRecord(values) ? values : {};
}

function valuesFields(manifest: ManifestDefinition, values: Readonly<Record<string, unknown>>): string[] {
  return manifest.fields.filter((f) => Object.hasOwn(values, f));
}

export function inScope(
  manifest: ManifestDefinition,
  args: Readonly<Record<string, unknown>>,
  record: Readonly<Record<string, unknown>>,
): boolean {
  for (const [arg, field] of Object.entries(manifest.scopeArgs)) {
    const allowed = args[arg];
    const actual = record[field];
    // A missing scope argument fails closed: nothing can match it.
    const ok = Array.isArray(allowed) ? allowed.some((a) => a === actual) : allowed !== undefined && allowed === actual;
    if (!ok) return false;
  }
  return true;
}

/** Each declared lookup's result for one target (OPS-7); supplied by preparation, `{}` without lookups. */
export type ItemLookups = (targetId: string) => CheckContext['lookups'];

/**
 * CS-3: an item that passed the built-in exclusions and fails a preparation check is excluded with
 * the check's code, keeping its values; the check inputs themselves are not stored (SEC-3).
 */
function checked(
  manifest: ManifestDefinition,
  item: ChangeItemRecord,
  ctx: Omit<CheckContext, 'before' | 'after'>,
): ChangeItemRecord {
  const checks = manifest.checks ?? [];
  if (item.status !== 'pending' || checks.length === 0) return item;
  const code = failedCheck(checks, { ...ctx, before: sideOf(item.before), after: sideOf(item.after) });
  return code === undefined ? item : excluded(item.targetId, code, item.before, item.after);
}

function sideOf(v: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(v) ? v : null;
}

function excluded(
  targetId: string,
  reason: ExclusionReason,
  before: unknown = null,
  after: unknown = null,
): ChangeItemRecord {
  return { targetId, status: 'excluded', reason, before, after };
}

function missingRequired(manifest: ManifestDefinition, values: Readonly<Record<string, unknown>>): boolean {
  return manifest.requiredFields.some((f) => values[f] === undefined || values[f] === null);
}

/**
 * The item of one create target (OPS-2, ADR 0071), whose values are its own record of the call. A
 * record already upstream is `already_exists`, holding the current values of the record's fields
 * only when that record is inside the call's scope (an out-of-scope record shows nothing, as for
 * `out_of_scope`). Scope and `required_fields` are checked against the new record's own values.
 */
function createItem(
  manifest: ManifestDefinition,
  args: Readonly<Record<string, unknown>>,
  targetId: string,
  existing: Readonly<Record<string, unknown>> | undefined,
  perRecord: ReadonlyMap<string, Readonly<Record<string, unknown>>> | undefined,
): ChangeItemRecord {
  const values = perRecord?.get(targetId) ?? {};
  if (existing !== undefined) {
    let before: Record<string, unknown> | null = null;
    if (inScope(manifest, args, existing)) {
      before = {};
      for (const f of valuesFields(manifest, values)) before[f] = existing[f] ?? null;
    }
    return excluded(targetId, 'already_exists', before, { ...values });
  }
  if (!inScope(manifest, args, values)) return excluded(targetId, 'out_of_scope');
  if (missingRequired(manifest, values)) return excluded(targetId, 'missing_data');
  return { targetId, status: 'pending', before: null, after: { ...values } };
}

/** The read records by their `idField` as a string; a record without one is skipped and the first wins. */
export function recordsById(
  manifest: ManifestDefinition,
  records: readonly Record<string, unknown>[],
): Map<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const id = record[manifest.idField];
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    const key = String(id);
    if (!byId.has(key)) byId.set(key, record);
  }
  return byId;
}

export function buildItems(input: {
  manifest: ManifestDefinition;
  args: Readonly<Record<string, unknown>>;
  targetIds: readonly string[];
  records: readonly Record<string, unknown>[];
  /** Lookup results per target for the checks (OPS-7); absent means none. */
  lookups?: ItemLookups;
}): ChangeItemRecord[] {
  const { manifest, args, targetIds, records } = input;
  const byId = recordsById(manifest, records);
  // One values object for every target, or each target's own record (CS-2).
  const perRecord = callRecords(manifest, args);
  const action = manifestAction(manifest);
  const lookups = input.lookups ?? (() => ({}));
  return targetIds.map((targetId) => {
    const record = byId.get(targetId);
    const item =
      action === 'create'
        ? createItem(manifest, args, targetId, record, perRecord)
        : existingItem(manifest, args, targetId, record, perRecord, action);
    return checked(manifest, item, { record, args, lookups: lookups(targetId) });
  });
}

/** The item of one update or delete target, from the current record (CS-2, CS-3, OPS-2). */
function existingItem(
  manifest: ManifestDefinition,
  args: Readonly<Record<string, unknown>>,
  targetId: string,
  record: Readonly<Record<string, unknown>> | undefined,
  perRecord: ReadonlyMap<string, Readonly<Record<string, unknown>>> | undefined,
  action: 'update' | 'delete',
): ChangeItemRecord {
  if (record === undefined) return excluded(targetId, 'not_found');
  if (!inScope(manifest, args, record)) return excluded(targetId, 'out_of_scope');
  if (missingRequired(manifest, record)) return excluded(targetId, 'missing_data');
  if (action === 'delete') {
    // What the approver sees and what drift compares: every manifest field, missing as null (OPS-2).
    const before: Record<string, unknown> = {};
    for (const f of manifest.fields) before[f] = record[f] ?? null;
    return { targetId, status: 'pending', before, after: null };
  }
  const values = perRecord === undefined ? valuesOf(manifest, args) : (perRecord.get(targetId) ?? {});
  const fields = valuesFields(manifest, values);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const f of fields) {
    before[f] = record[f] ?? null;
    after[f] = values[f];
  }
  if (fields.every((f) => deepEqual(before[f], after[f]))) return excluded(targetId, 'no_change', before, after);
  return { targetId, status: 'pending', before, after };
}
