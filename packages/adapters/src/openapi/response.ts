import type { ResponseMapping } from '@aiops/connector-sdk';
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

function clip(v: unknown): unknown {
  if (typeof v === 'string') return v.length > MAX_STRING ? v.slice(0, MAX_STRING) + MARKER : v;
  if (Array.isArray(v)) return v.map(clip);
  if (isObj(v)) {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) set(out, k, clip(x));
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
): { items?: Record<string, unknown>[]; total?: number; value?: unknown; truncated: boolean } {
  const result: { items?: Record<string, unknown>[]; total?: number; value?: unknown; truncated: boolean } = { truncated: false };

  if (mapping.total !== undefined) {
    const t = dotted(body, mapping.total);
    if (typeof t === 'number' && Number.isFinite(t)) result.total = t;
  }

  if (mapping.items === undefined) {
    result.value = clip(body);
    return result;
  }
  const raw = dotted(body, mapping.items);
  if (!Array.isArray(raw)) throw new MappingError('response items path is not an array');
  if (raw.length > mapping.maxItems) result.truncated = true;

  const fieldsArg = mapping.fieldsFromArg !== undefined && Object.hasOwn(args, mapping.fieldsFromArg) ? args[mapping.fieldsFromArg] : undefined;
  const fields = Array.isArray(fieldsArg) ? fieldsArg.filter((x): x is string => typeof x === 'string') : undefined;

  result.items = (raw as unknown[]).slice(0, mapping.maxItems).map((it) => {
    const flat = mapping.flatten ? flattenItem(it, mapping.flatten) : it;
    let item: Obj = isObj(flat) ? flat : { value: flat };
    if (fields) {
      const proj: Obj = {};
      for (const k of fields) if (Object.hasOwn(item, k)) set(proj, k, item[k]);
      item = proj;
    }
    return clip(item) as Obj;
  });
  return result;
}
