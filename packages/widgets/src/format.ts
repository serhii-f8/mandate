// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
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
