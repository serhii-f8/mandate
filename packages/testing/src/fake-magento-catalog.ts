// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { FakeResponse, FakeUpstream, RecordedRequest } from './fake-upstream.js';

/** A flat product: `sku` plus name, status, brand, description, ... */
export interface FakeMagentoProduct {
  readonly sku: string;
  readonly [field: string]: unknown;
}

export interface FakeMagentoCatalog {
  readonly basePath: string;
  /** A flat copy of the product, or undefined. */
  product(sku: string): Readonly<Record<string, unknown>> | undefined;
  /** An external edit: merges the fields into the product, creating it when unknown. */
  set(sku: string, fields: Readonly<Record<string, unknown>>): void;
  remove(sku: string): void;
  readonly submissions: readonly { readonly batchId: string; readonly skus: readonly string[] }[];
  /** Their operations end in status 3 and are not applied. */
  failItems(skus: readonly string[]): void;
  /** The next n status GETs answer 503. */
  failStatusRequests(n: number): void;
  /** Status polls per bulk answered "4 open" before the bulk applies. */
  openPolls: number;
  /** Every bulk submitted so far, in submission order, with whether it has been applied. */
  bulks(): readonly { readonly batchId: string; readonly skus: readonly string[]; readonly applied: boolean }[];
  /** Back to the seed: products, submissions, bulks, failing items, status failures and `openPolls`. Routes stay. */
  reset(): void;
  /** Called after an item is applied (a verify-drift hook). */
  onApplied?: (sku: string) => void;
}

/** Attributes Magento returns at the top level of a raw product; everything else is a custom attribute. */
const TOP_LEVEL = new Set(['sku', 'name', 'status', 'price', 'type_id', 'visibility', 'updated_at']);

const STATUS_COMPLETE = 1;
const STATUS_FAILED = 3;
const STATUS_OPEN = 4;

interface Bulk {
  readonly id: string;
  readonly items: readonly Record<string, unknown>[];
  polls: number;
  applied: boolean;
  statuses: number[];
}

function json(status: number, body: unknown): FakeResponse {
  return { status, body };
}

function toRaw(p: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  const custom: { attribute_code: string; value: unknown }[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (TOP_LEVEL.has(k)) raw[k] = v;
    else custom.push({ attribute_code: k, value: v });
  }
  raw.custom_attributes = custom;
  return raw;
}

function likeToRegExp(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matches(p: Readonly<Record<string, unknown>>, field: string, value: string, condition: string): boolean {
  const have = p[field];
  const text = typeof have === 'string' || typeof have === 'number' || typeof have === 'boolean' ? String(have) : undefined;
  switch (condition) {
    case 'eq':
      return text === value;
    case 'in':
      return text !== undefined && value.split(',').includes(text);
    case 'like':
      return text !== undefined && likeToRegExp(value).test(text);
    default:
      return false;
  }
}

interface FilterGroup {
  readonly filters: { readonly field: string; readonly value: string; readonly condition: string }[];
}

/** Reads searchCriteria[filter_groups][g][filters][f][field|value|condition_type] into groups. */
function parseGroups(query: URLSearchParams): FilterGroup[] {
  const groups = new Map<number, Map<number, { field?: string; value?: string; condition?: string }>>();
  for (const [key, val] of query) {
    const m = /^searchCriteria\[filter_groups\]\[(\d+)\]\[filters\]\[(\d+)\]\[(field|value|condition_type)\]$/.exec(key);
    if (!m) continue;
    const g = Number(m[1]);
    const f = Number(m[2]);
    const part = m[3];
    const filters = groups.get(g) ?? new Map<number, { field?: string; value?: string; condition?: string }>();
    groups.set(g, filters);
    const filter = filters.get(f) ?? {};
    filters.set(f, filter);
    if (part === 'field') filter.field = val;
    else if (part === 'value') filter.value = val;
    else filter.condition = val;
  }
  return [...groups.values()].map((filters) => ({
    filters: [...filters.values()].map((f) => ({ field: f.field ?? '', value: f.value ?? '', condition: f.condition ?? 'eq' })),
  }));
}

/** Parses a bulk body: an array of `{ product: { sku, ... } }`, or undefined. */
function parseBulkBody(body: string): Record<string, unknown>[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const items: Record<string, unknown>[] = [];
  for (const entry of parsed as unknown[]) {
    const product = (entry as { product?: unknown } | null)?.product;
    if (typeof product !== 'object' || product === null || typeof (product as { sku?: unknown }).sku !== 'string') return undefined;
    items.push(product as Record<string, unknown>);
  }
  return items;
}

/**
 * A Magento-like catalog on a FakeUpstream: product search, the async bulk write and its detailed status.
 * Imitates the subset the preset uses (ADR 0007, spike 5): an async write that omits `status` resets the
 * product to enabled, and operations are reported in reverse index order.
 */
export function installFakeMagentoCatalog(
  up: FakeUpstream,
  opts: { readonly basePath?: string; readonly products: readonly FakeMagentoProduct[]; readonly openPolls?: number },
): FakeMagentoCatalog {
  const basePath = opts.basePath ?? '/rest/all';
  const products = new Map<string, Record<string, unknown>>();
  const seed = (): void => {
    products.clear();
    for (const p of opts.products) products.set(p.sku, { ...p });
  };
  seed();
  const submissions: { batchId: string; skus: string[] }[] = [];
  const bulks = new Map<string, Bulk>();
  const failing = new Set<string>();
  let failStatus = 0;

  const catalog: FakeMagentoCatalog = {
    basePath,
    openPolls: opts.openPolls ?? 1,
    submissions,
    product: (sku) => {
      const p = products.get(sku);
      return p === undefined ? undefined : { ...p };
    },
    set: (sku, fields) => {
      products.set(sku, { ...products.get(sku), ...fields, sku });
    },
    remove: (sku) => {
      products.delete(sku);
    },
    failItems: (skus) => {
      for (const s of skus) failing.add(s);
    },
    failStatusRequests: (n) => {
      failStatus = n;
    },
    bulks: () => [...bulks.values()].map((b) => ({ batchId: b.id, skus: b.items.map((i) => i.sku as string), applied: b.applied })), // parseBulkBody guarantees a string sku
    reset: () => {
      seed();
      submissions.length = 0;
      bulks.clear();
      failing.clear();
      failStatus = 0;
      catalog.openPolls = opts.openPolls ?? 1;
    },
  };

  const apply = (bulk: Bulk): void => {
    bulk.applied = true;
    bulk.statuses = bulk.items.map((item) => {
      const sku = item.sku as string; // parseBulkBody guarantees a string sku
      const existing = products.get(sku);
      if (existing === undefined || failing.has(sku)) return STATUS_FAILED;
      const { custom_attributes: custom, ...top } = item;
      const next: Record<string, unknown> = { ...existing, ...top };
      if (Array.isArray(custom)) {
        for (const c of custom as { attribute_code?: unknown; value?: unknown }[]) {
          if (typeof c.attribute_code === 'string') next[c.attribute_code] = c.value;
        }
      }
      if (!('status' in item)) next.status = 1; // the hazard in ADR 0007
      products.set(sku, next);
      catalog.onApplied?.(sku);
      return STATUS_COMPLETE;
    });
  };

  up.route('GET', `${basePath}/V1/products`, (req: RecordedRequest) => {
    const groups = parseGroups(req.query);
    const hits = [...products.values()]
      .filter((p) => groups.every((g) => g.filters.some((f) => matches(p, f.field, f.value, f.condition))))
      .sort((a, b) => (a.sku as string).localeCompare(b.sku as string));
    const pageSize = Number(req.query.get('pageSize') ?? hits.length) || hits.length;
    const page = Math.max(1, Number(req.query.get('currentPage') ?? 1) || 1);
    const items = hits.slice((page - 1) * pageSize, page * pageSize).map(toRaw);
    return json(200, { items, search_criteria: {}, total_count: hits.length });
  });

  up.route('POST', `${basePath}/async/bulk/V1/products`, (req) => {
    const items = parseBulkBody(req.body);
    if (items === undefined) return json(400, { message: 'Request body must be an array' });
    const batchId = `fake-bulk-${submissions.length + 1}`;
    submissions.push({ batchId, skus: items.map((i) => i.sku as string) });
    bulks.set(batchId, { id: batchId, items, polls: 0, applied: false, statuses: [] });
    return json(202, {
      bulk_uuid: batchId,
      request_items: items.map((_, id) => ({ id, data_hash: 'x', status: 'accepted' })),
      errors: false,
    });
  });

  const statusPattern = new RegExp(`^${basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/V1/bulk/([^/]+)/detailed-status$`);
  up.routeMatch('GET', statusPattern, (req) => {
    if (failStatus > 0) {
      failStatus -= 1;
      return json(503, { message: 'Service unavailable' });
    }
    const id = decodeURIComponent(statusPattern.exec(req.path)?.[1] ?? '');
    const bulk = bulks.get(id);
    if (bulk === undefined) return json(404, { message: 'Specified bulk does not exist' });
    if (!bulk.applied) {
      if (bulk.polls < catalog.openPolls) bulk.polls += 1;
      else apply(bulk);
    }
    const operations = bulk.items.map((item, index) => ({
      id: index,
      status: bulk.applied ? (bulk.statuses[index] ?? STATUS_FAILED) : STATUS_OPEN,
      result_message: `fake upstream message ${item.sku as string}`,
      serialized_data: null,
    }));
    return json(200, { operations_list: operations.reverse() });
  });

  return catalog;
}
