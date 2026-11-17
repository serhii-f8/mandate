import type { ManifestDefinition } from '../policy-model.js';
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

/** Keys of the values argument, in manifest `fields` order. */
export function touchedFields(manifest: ManifestDefinition, args: Readonly<Record<string, unknown>>): string[] {
  const values = args[manifest.valuesArg];
  if (!isRecord(values)) return [];
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
  const fields = touchedFields(manifest, args);
  const rawValues = args[manifest.valuesArg];
  const values: Record<string, unknown> = isRecord(rawValues) ? rawValues : {};

  return targetIds.map((targetId): ChangeItemRecord => {
    const record = byId.get(targetId);
    if (record === undefined) return excluded(targetId, 'not_found');
    if (!inScope(manifest, args, record)) return excluded(targetId, 'out_of_scope');
    if (manifest.requiredFields.some((f) => record[f] === undefined || record[f] === null)) {
      return excluded(targetId, 'missing_data');
    }
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
