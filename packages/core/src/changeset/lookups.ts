// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Preparation lookups (OPS-7, ADR 0072): reads of an enabled read operation on any connection, keyed
 * per item, whose results feed the preparation checks. A lookup value is read and dropped: it never
 * reaches a stored item, a log, the audit, a tool result or workflow history (SEC-3).
 */
import type { ManifestDefinition, ManifestLookup } from '../policy-model.js';
import type { CheckContext } from './checks.js';
import { PreparationFailure } from './failure.js';
import { buildItems, recordsById, type ItemLookups } from './items.js';
import type { UpstreamReader } from './ports.js';
import { resolveTemplates } from './templates.js';

type Fields = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is Fields {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fieldOf(source: unknown, name: string): unknown {
  return isRecord(source) && Object.hasOwn(source, name) ? source[name] : undefined;
}

/** A string or number value as a string; anything else is no key. */
function asKey(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/** The key of one item for one lookup, or `undefined` when the item has none (the lookup is then "not found"). */
export function lookupKey(
  lookup: ManifestLookup,
  input: { targetId: string; before: unknown; after: unknown; record: Readonly<Record<string, unknown>> | undefined },
): string | undefined {
  const key = lookup.key;
  if ('target' in key) return input.targetId;
  if ('after' in key) return asKey(fieldOf(input.after, key.after));
  if ('before' in key) return asKey(fieldOf(input.before, key.before));
  if ('record' in key) return asKey(fieldOf(input.record, key.record));
  // A key of a shape outside the four (which the loader cannot produce) finds nothing.
  return undefined;
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Reads every declared lookup for the given keys: per lookup, the distinct keys in chunks of
 * `chunkSize`, one read each. The results are indexed by `String(record[keyField])`, the first record
 * with a key winning. A failed read throws `lookup_failed` with the upstream status, a truncated one
 * `incomplete_read`: a lookup that could not be read completely is never "not found".
 */
export async function readLookups(input: {
  manifest: ManifestDefinition;
  args: Readonly<Record<string, unknown>>;
  keysByLookup: ReadonlyMap<string, readonly string[]>;
  reader: UpstreamReader;
  readFieldsArg: (operationId: string) => string | undefined;
  chunkSize: number;
}): Promise<ReadonlyMap<string, ReadonlyMap<string, Fields>>> {
  const out = new Map<string, Map<string, Fields>>();
  for (const [name, lookup] of Object.entries(input.manifest.lookups ?? {})) {
    const results = new Map<string, Fields>();
    out.set(name, results);
    const keys = [...new Set(input.keysByLookup.get(name) ?? [])];
    if (keys.length === 0) continue;
    const fieldsArg = input.readFieldsArg(lookup.operation);
    const fixedArgs = resolveTemplates(lookup.args, input.args);
    for (const chunk of chunks(keys, input.chunkSize)) {
      const page = await input.reader.read(lookup.operation, {
        ...fixedArgs,
        [lookup.idsArg]: chunk,
        ...(fieldsArg === undefined ? {} : { [fieldsArg]: [lookup.keyField, ...lookup.fields] }),
      });
      // Only the fixed code and the status leave; the upstream's message stays behind (SEC-3).
      if (!page.ok) throw new PreparationFailure('lookup_failed', page.status);
      if (page.truncated) throw new PreparationFailure('incomplete_read');
      for (const record of page.items) {
        const key = asKey(record[lookup.keyField]);
        if (key !== undefined && !results.has(key)) results.set(key, record);
      }
    }
  }
  return out;
}

/**
 * The per-target lookup view of one read chunk for `buildItems`, or `undefined` when the manifest
 * declares no lookups. Only the items that would still be pending without the checks are looked up;
 * every other item is excluded already and runs no check.
 */
export async function chunkLookups(input: {
  manifest: ManifestDefinition;
  args: Readonly<Record<string, unknown>>;
  targetIds: readonly string[];
  records: readonly Record<string, unknown>[];
  reader: UpstreamReader;
  readFieldsArg: (operationId: string) => string | undefined;
}): Promise<ItemLookups | undefined> {
  const { manifest } = input;
  const declared = Object.entries(manifest.lookups ?? {});
  if (declared.length === 0) return undefined;
  const { args, targetIds, records } = input;
  const byId = recordsById(manifest, records);
  const candidates = buildItems({ manifest: { ...manifest, checks: [] }, args, targetIds, records }).filter((i) => i.status === 'pending');
  const keysByTarget = new Map<string, Map<string, string>>();
  const keysByLookup = new Map<string, string[]>(declared.map(([name]) => [name, []]));
  for (const item of candidates) {
    const keys = new Map<string, string>();
    const sides = { targetId: item.targetId, before: item.before, after: item.after, record: byId.get(item.targetId) };
    for (const [name, lookup] of declared) {
      const key = lookupKey(lookup, sides);
      if (key === undefined) continue;
      keys.set(name, key);
      keysByLookup.get(name)?.push(key);
    }
    keysByTarget.set(item.targetId, keys);
  }
  const results = await readLookups({ manifest, args, keysByLookup, reader: input.reader, readFieldsArg: input.readFieldsArg, chunkSize: manifest.batchSize });
  return (targetId): CheckContext['lookups'] => {
    const keys = keysByTarget.get(targetId);
    // fromEntries defines own properties, whatever the lookup's name.
    return Object.fromEntries(
      declared.map(([name]): [string, Fields | undefined] => {
        const key = keys?.get(name);
        return [name, key === undefined ? undefined : results.get(name)?.get(key)];
      }),
    );
  };
}
