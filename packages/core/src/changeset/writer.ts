import type { ManifestDefinition } from '../policy-model.js';
import { canonicalJson } from './canonical.js';
import { inScope, touchedFields } from './items.js';
import type { ChangeItemRecord } from './model.js';

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
