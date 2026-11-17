import type { HttpMethod, TemplateValue, UpstreamMapping } from '@aiops/connector-sdk';
import { FORBIDDEN_HEADERS } from '../http/headers.js';

/** Raised for mapping/argument problems. Messages never contain argument values (SEC-3). */
export class MappingError extends Error {
  override readonly name = 'MappingError';
}

export interface HttpRequestSpec {
  method: HttpMethod;
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

type Scalar = string | number | boolean;
const isScalar = (v: unknown): v is Scalar => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Resolve a template to its raw value; undefined means "omit". */
function resolve(t: TemplateValue, args: Readonly<Record<string, unknown>>): unknown {
  if (typeof t === 'object') {
    const v = Object.hasOwn(args, t.arg) ? args[t.arg] : undefined;
    return v ?? t.default;
  }
  return t;
}

/** Resolve to a scalar or array of scalars (query, path, header); objects are rejected. */
function resolveScalars(name: string, t: TemplateValue, args: Readonly<Record<string, unknown>>): Scalar[] | undefined {
  const v = resolve(t, args);
  if (v === undefined) return undefined;
  if (isScalar(v)) return [v];
  if (Array.isArray(v) && v.every(isScalar)) return v;
  throw new MappingError(`parameter ${name} must be a scalar or an array of scalars`);
}

const isDotSegment = (v: string): boolean => v === '.' || v === '..';

export function buildRequest(
  baseUrl: string,
  mapping: UpstreamMapping & { method: HttpMethod; path: string },
  args: Readonly<Record<string, unknown>>,
): HttpRequestSpec {
  if (/[?#]/.test(baseUrl)) throw new MappingError('base URL must not contain a query or fragment');
  const path = mapping.path.replace(/\{([^{}]+)\}/g, (_m, name: string) => {
    const tpl = Object.hasOwn(mapping.pathParams, name) ? mapping.pathParams[name] : undefined;
    const vals = tpl ? resolveScalars(name, tpl, args) : undefined;
    const raw = vals?.length === 1 ? String(vals[0]) : '';
    // An empty segment would silently address another resource.
    if (raw === '') throw new MappingError(`path parameter ${name} has no value`);
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // not decodable: the raw value is checked as is
    }
    // Dot segments would escape the operation path once the upstream normalises the URL.
    if (isDotSegment(raw) || isDotSegment(decoded)) throw new MappingError(`path parameter ${name} is not allowed`);
    return encodeURIComponent(raw);
  });

  const url = new URL(baseUrl.replace(/\/+$/, '') + path);
  for (const [key, tpl] of Object.entries(mapping.query)) {
    const vals = resolveScalars(key, tpl, args);
    if (vals === undefined) continue;
    for (const v of vals) url.searchParams.append(key, String(v));
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  for (const [name, tpl] of Object.entries(mapping.headers)) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) throw new MappingError(`header ${lower} is not allowed`);
    const vals = resolveScalars(name, tpl, args);
    if (vals === undefined) continue;
    headers[lower] = vals.map(String).join(', ');
  }

  const spec: HttpRequestSpec = { method: mapping.method, url, headers };
  if (mapping.body !== undefined) {
    const b = resolve(mapping.body, args);
    if (b !== undefined) {
      spec.body = JSON.stringify(b);
      headers['content-type'] = 'application/json';
    }
  }
  return spec;
}
