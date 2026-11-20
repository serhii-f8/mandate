/**
 * A test-only `CodeContext` that answers `ctx.http.send` from recorded exchanges, in order.
 * A request that differs from the next exchange (method, path, query, body), an extra call or a
 * header the code should not set throws. Query values are compared as the adapter sends them:
 * `String()`-ed, arrays as repeated parameters (queryPairs of packages/adapters/src/code/http.ts).
 * A non-2xx exchange answers like the adapter: `{ ok: false, code: 'http_status', status }`, no body.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { CodeContext, CodeHttpRequest, CodeHttpResponse, ReadErrorCode } from '@aiops/connector-sdk';
import type { RecordedExchange } from '@aiops/testing';

/** A recorded exchange, or one whose answer is a transport code (`timeout`, `network`, `busy`, …). */
export type ReplayExchange =
  | RecordedExchange
  | {
      readonly request: { readonly method: string; readonly path: string; readonly query?: Readonly<Record<string, string | readonly string[]>>; readonly body?: unknown };
      readonly response: { readonly code: ReadErrorCode; readonly status?: number };
    };

export interface Replay {
  readonly ctx: CodeContext;
  /** Requests the code sent, matched or not. */
  readonly calls: () => number;
  /** Exchanges not yet asked for. */
  readonly pending: () => number;
}

const root = fileURLToPath(new URL('..', import.meta.url));

/** The exchanges of `test/recordings/<name>.json` (`write/<name>` for a write recording). */
export async function recording(name: string): Promise<RecordedExchange[]> {
  const parsed = JSON.parse(await readFile(join(root, 'test', 'recordings', `${name}.json`), 'utf8')) as { exchanges: RecordedExchange[] };
  return parsed.exchanges;
}

function pairs(query: Readonly<Record<string, unknown>> | undefined): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    for (const v of Array.isArray(value) ? (value as unknown[]) : [value]) out.push(`${key}=${String(v)}`);
  }
  return out.sort();
}

function describe(r: { method: string; path: string; query?: unknown }): string {
  return `${r.method} ${r.path} ${JSON.stringify(r.query ?? {})}`;
}

export function replay(exchanges: readonly ReplayExchange[]): Replay {
  const queue = [...exchanges];
  let calls = 0;
  const send = (request: CodeHttpRequest): Promise<CodeHttpResponse> => {
    calls += 1;
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new Error(`replay: unexpected extra request ${describe(request)}`));
    const want = next.request;
    const sentBody: unknown = request.body === undefined ? undefined : JSON.parse(JSON.stringify(request.body));
    const same =
      request.method === want.method.toUpperCase() &&
      request.path === want.path &&
      isDeepStrictEqual(pairs(request.query), pairs(want.query)) &&
      isDeepStrictEqual(sentBody, want.body) &&
      request.headers === undefined;
    if (!same) return Promise.reject(new Error(`replay: got ${describe(request)}, expected ${describe(want)}`));
    const res = next.response;
    if ('code' in res) return Promise.resolve({ ok: false, code: res.code, ...(res.status === undefined ? {} : { status: res.status }) });
    if (res.status >= 200 && res.status < 300) return Promise.resolve({ ok: true, status: res.status, json: res.body });
    return Promise.resolve({ ok: false, code: 'http_status', status: res.status });
  };
  const ctx: CodeContext = { http: { send }, signal: new AbortController().signal, connection: { id: 'gitea' } };
  return { ctx, calls: () => calls, pending: () => queue.length };
}
