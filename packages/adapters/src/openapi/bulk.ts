import type { BulkItemState, BulkMapping } from '@aiops/connector-sdk';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// defineProperty keeps keys like "__proto__" as plain data properties.
function set(o: Obj, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function dotted(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of path.split('.')) {
    if (!isObj(cur) || !Object.hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function shape(body: BulkMapping['body'], record: Readonly<Record<string, unknown>>): unknown {
  const nest = body.nest;
  const out: Obj = {};
  const nested: unknown[] = [];
  for (const [k, v] of Object.entries(record)) {
    if (!nest || nest.keep.includes(k)) set(out, k, v);
    else {
      const entry: Obj = {};
      set(entry, nest.key, k);
      set(entry, nest.value, v);
      nested.push(entry);
    }
  }
  if (nest && nested.length > 0) set(out, nest.path, nested);
  if (body.wrap === undefined) return out;
  const wrapped: Obj = {};
  set(wrapped, body.wrap, out);
  return wrapped;
}

export function buildBulkBody(body: BulkMapping['body'], records: readonly Readonly<Record<string, unknown>>[]): unknown[] {
  return records.map((r) => shape(body, r));
}

export function extractBatchId(json: unknown, path: string): string | undefined {
  const v = dotted(json, path);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export function isSafeBatchId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id);
}

/**
 * Maps a bulk status answer to `{ index, state }` per entry (OPS-6).
 *
 * Index mode (`status.index`): the entry's field is its position; entries without a
 * non-negative integer are dropped. Key mode (`status.key`): the entry's field is a target ID
 * (string, or finite number compared as its decimal string) looked up in `keys`, the to-write
 * target IDs in plan order. An unknown or unreadable key is emitted as `index: keys.length`,
 * out of range, so core skips it exactly like an out-of-range index instead of reading an
 * answer of foreign keys as "still open". Key mode without `keys` answers undefined.
 */
export function mapBulkStatus(
  status: BulkMapping['status'],
  json: unknown,
  keys?: readonly string[],
): { index: number; state: BulkItemState }[] | undefined {
  const keyField = status.key;
  const indexField = status.index;
  if (keyField === undefined && indexField === undefined) return undefined;
  if (keyField !== undefined && keys === undefined) return undefined;
  const list = dotted(json, status.items);
  if (!Array.isArray(list)) return undefined;
  const out: { index: number; state: BulkItemState }[] = [];
  const has = (set_: readonly unknown[], v: unknown): boolean => set_.some((x) => x === v);
  const positionOf = (e: Obj): number | undefined => {
    if (keyField !== undefined && keys !== undefined) {
      const k = e[keyField];
      const id = typeof k === 'string' ? k : typeof k === 'number' && Number.isFinite(k) ? String(k) : undefined;
      const at = id === undefined ? -1 : keys.indexOf(id);
      return at === -1 ? keys.length : at;
    }
    const index = indexField === undefined ? undefined : e[indexField];
    return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : undefined;
  };
  for (const e of list) {
    if (!isObj(e)) continue;
    const index = positionOf(e);
    if (index === undefined) continue;
    const raw = e[status.state];
    // A state in no list is failed, never open.
    let state: BulkItemState = 'failed';
    if (has(status.states.ok, raw)) state = 'ok';
    else if (has(status.states.retriable, raw)) state = 'retriable';
    else if (has(status.states.open, raw)) state = 'open';
    out.push({ index, state });
  }
  return out;
}
