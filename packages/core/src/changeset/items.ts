// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ManifestDefinition } from '../policy-model.js';
import { callRecords } from './fields.js';
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

function excluded(
  targetId: string,
  reason: ExclusionReason,
  before: unknown = null,
  after: unknown = null,
): ChangeItemRecord {
  return { targetId, status: 'excluded', reason, before, after };
}

export function buildItems(input: {
  manifest: ManifestDefinition;
  args: Readonly<Record<string, unknown>>;
  targetIds: readonly string[];
  records: readonly Record<string, unknown>[];
}): ChangeItemRecord[] {
  const { manifest, args, targetIds, records } = input;
  const byId = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const id = record[manifest.idField];
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    const key = String(id);
    if (!byId.has(key)) byId.set(key, record);
  }
  // One values object for every target, or each target's own record (CS-2).
  const perRecord = callRecords(manifest, args);
  const shared = valuesOf(manifest, args);
  const sharedFields = valuesFields(manifest, shared);

  return targetIds.map((targetId): ChangeItemRecord => {
    const record = byId.get(targetId);
    if (record === undefined) return excluded(targetId, 'not_found');
    if (!inScope(manifest, args, record)) return excluded(targetId, 'out_of_scope');
    if (manifest.requiredFields.some((f) => record[f] === undefined || record[f] === null)) {
      return excluded(targetId, 'missing_data');
    }
    const values = perRecord === undefined ? shared : (perRecord.get(targetId) ?? {});
    const fields = perRecord === undefined ? sharedFields : valuesFields(manifest, values);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const f of fields) {
      before[f] = record[f] ?? null;
      after[f] = values[f];
    }
    if (fields.every((f) => deepEqual(before[f], after[f]))) return excluded(targetId, 'no_change', before, after);
    return { targetId, status: 'pending', before, after };
  });
}
