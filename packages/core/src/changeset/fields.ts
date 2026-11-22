// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The fields a change-set touches (CS-2, OPS-2): from one values object for every target
 * (`values_arg`), or from each target's own record (`records_arg`, ADR 0070).
 */
import type { ManifestAction, ManifestDefinition } from '../policy-model.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** What the manifest does to its targets; an absent `action` is `update` (OPS-2). */
export function manifestAction(m: ManifestDefinition): ManifestAction {
  return m.action ?? 'update';
}

/**
 * Each record of a `records_arg` call by target ID, holding only its `fields` values in manifest
 * order (the identifier dropped). `undefined` when the manifest has no `recordsArg`. The arguments
 * were normalized (`normalizeRecords`), so a record without an identifier or a repeated one is a bug
 * and throws `TypeError`.
 */
export function callRecords(
  m: ManifestDefinition,
  args: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, Readonly<Record<string, unknown>>> | undefined {
  if (m.recordsArg === undefined) return undefined;
  const raw = args[m.recordsArg];
  const out = new Map<string, Readonly<Record<string, unknown>>>();
  if (!Array.isArray(raw)) return out;
  for (const record of raw as unknown[]) {
    if (!isRecord(record)) throw new TypeError('callRecords: a record must be an object');
    const id = record[m.idField];
    if (typeof id !== 'string' && typeof id !== 'number') throw new TypeError('callRecords: record without an identifier');
    const key = String(id);
    if (out.has(key)) throw new TypeError('callRecords: duplicate record identifier');
    const values: Record<string, unknown> = {};
    for (const f of m.fields) if (f !== m.idField && Object.hasOwn(record, f)) values[f] = record[f];
    out.set(key, values);
  }
  return out;
}

/**
 * The manifest fields one stored item touches: the own keys of `after` when it is an object, else
 * of `before` when that is one, else none. Drift, the write and the verify compare over these.
 */
export function itemFields(m: ManifestDefinition, item: { readonly before: unknown; readonly after: unknown }): string[] {
  const side = isRecord(item.after) ? item.after : isRecord(item.before) ? item.before : undefined;
  if (side === undefined) return [];
  return m.fields.filter((f) => Object.hasOwn(side, f));
}
