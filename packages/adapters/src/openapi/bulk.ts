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

export function mapBulkStatus(
  status: BulkMapping['status'],
  json: unknown,
): { index: number; state: BulkItemState }[] | undefined {
  const list = dotted(json, status.items);
  if (!Array.isArray(list)) return undefined;
  const out: { index: number; state: BulkItemState }[] = [];
  const has = (set_: readonly unknown[], v: unknown): boolean => set_.some((x) => x === v);
  for (const e of list) {
    if (!isObj(e)) continue;
    const index = e[status.index];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue;
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
