// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ItemRowModel } from './model.js';

/** Text shown for a value: strings as they are, undefined empty, anything else as JSON. */
export function displayValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return '';
  return JSON.stringify(v, null, 2);
}

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** A byte count as `512 B`, `2.0 KB`, `1.5 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function shortHash(hash: string): string {
  const m = /^([a-z0-9]+:)([0-9a-f]{9,})$/i.exec(hash);
  return m ? `${m[1]}${m[2]?.slice(0, 8)}…` : hash;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatDateTime(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(d);
}

/** Shown for the side a creation or deletion does not have. */
export const ABSENT = '—';

export interface FieldRow {
  field?: string;
  before: string;
  after: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function fieldRows(item: Pick<ItemRowModel, 'before' | 'after'>): FieldRow[] {
  const { before, after } = item;
  // APR-6: a creation has no before, a deletion no after; the missing side shows a dash in every row.
  if (before === null || after === null) {
    const present = before === null ? after : before;
    const side = (v: unknown): string => (v === null ? ABSENT : displayValue(v));
    if (before === null && after === null) return [{ before: ABSENT, after: ABSENT }];
    if (!isPlainObject(present)) return [{ before: side(before), after: side(after) }];
    return Object.keys(present)
      .sort((a, b) => a.localeCompare(b))
      .map((k) => ({
        field: k,
        before: before === null ? ABSENT : displayValue(present[k]),
        after: after === null ? ABSENT : displayValue(present[k]),
      }));
  }
  if (!isPlainObject(before) || !isPlainObject(after)) {
    return [{ before: displayValue(before), after: displayValue(after) }];
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((a, b) =>
    a.localeCompare(b),
  );
  const changed = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  return (changed.length > 0 ? changed : keys).map((k) => ({
    field: k,
    before: displayValue(before[k]),
    after: displayValue(after[k]),
  }));
}
