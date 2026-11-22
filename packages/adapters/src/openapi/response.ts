// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ResponseMapping } from '@mandate/connector-sdk';
import { MappingError } from './request.js';

const MAX_STRING = 4000;
const MARKER = '…[truncated]';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function dotted(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of path.split('.')) {
    if (!isObj(cur) || !Object.hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// defineProperty keeps keys like "__proto__" as plain data properties.
function set(o: Obj, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function clipStrings(v: unknown): unknown {
  if (typeof v === 'string') return v.length > MAX_STRING ? v.slice(0, MAX_STRING) + MARKER : v;
  if (Array.isArray(v)) return v.map(clipStrings);
  if (isObj(v)) {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) set(out, k, clipStrings(x));
    return out;
  }
  return v;
}

function flattenItem(item: unknown, f: NonNullable<ResponseMapping['flatten']>): unknown {
  if (!isObj(item) || !Object.hasOwn(item, f.path)) return item;
  const entries = item[f.path];
  const out: Obj = {};
  for (const [k, v] of Object.entries(item)) if (k !== f.path) set(out, k, v);
  if (Array.isArray(entries)) {
    for (const e of entries) {
      if (!isObj(e)) continue;
      const key = e[f.key];
      if (typeof key !== 'string' || Object.hasOwn(out, key)) continue;
      set(out, key, e[f.value]);
    }
  }
  return out;
}

export function mapResponse(
  mapping: ResponseMapping,
  body: unknown,
  args: Readonly<Record<string, unknown>>,
  options: { readonly exactValues?: boolean } = {},
): { items?: Record<string, unknown>[]; total?: number; value?: unknown; truncated: boolean } {
  const result: { items?: Record<string, unknown>[]; total?: number; value?: unknown; truncated: boolean } = { truncated: false };

  if (mapping.total !== undefined) {
    const t = dotted(body, mapping.total);
    if (typeof t === 'number' && Number.isFinite(t)) result.total = t;
  }

  let fields: string[] | undefined;
  if (mapping.fieldsFromArg !== undefined) {
    // Fail closed: without an explicit field list nothing is returned (POL-3).
    const arg = Object.hasOwn(args, mapping.fieldsFromArg) ? args[mapping.fieldsFromArg] : undefined;
    if (!Array.isArray(arg) || !arg.every((x): x is string => typeof x === 'string')) throw new MappingError('fields argument is missing');
    fields = arg;
  }

  // Exact values (change-set before values) are never clipped: a clipped value would be stored as the truth.
  const clip = options.exactValues === true ? (v: unknown): unknown => v : clipStrings;

  /** Flatten, then project; undefined means the entry cannot be projected and is dropped. */
  const shape = (entry: unknown): unknown => {
    const flat = mapping.flatten ? flattenItem(entry, mapping.flatten) : entry;
    if (fields === undefined) return clip(flat);
    if (!isObj(flat)) return undefined;
    const proj: Obj = {};
    for (const k of fields) if (Object.hasOwn(flat, k)) set(proj, k, flat[k]);
    return clip(proj);
  };

  if (mapping.items === undefined) {
    // A single object goes through the same flatten and projection as items (POL-3).
    result.value = shape(body) ?? {};
    return result;
  }
  // `$` is the body itself, for upstreams that answer a bare JSON array (Global Constraint "Root-array responses").
  const raw = mapping.items === '$' ? body : dotted(body, mapping.items);
  if (!Array.isArray(raw)) throw new MappingError('response items path is not an array');
  if (raw.length > mapping.maxItems) result.truncated = true;

  const items: Obj[] = [];
  for (const it of (raw as unknown[]).slice(0, mapping.maxItems)) {
    const shaped = shape(it);
    // Without projection non-object items pass through unchanged; with it they are dropped.
    if (shaped !== undefined) items.push(shaped as Obj);
  }
  result.items = items;
  return result;
}
