// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The guarded HTTP client a preset's code operation gets as `ctx.http` (OPS-5). Every request is
 * relative to the connection's base URL and goes through the connection's own client, so the
 * egress guard, semaphore, timeouts, credential injection and scrubbing apply (CONN-3, CONN-5,
 * SEC-2, SEC-3). The code never sees the credential; a non-2xx answer carries its status only.
 */
import type {
  CodeHttpClient,
  CodeHttpRequest,
  CodeHttpResponse,
  ConnectionSettings,
  CredentialSource,
  HttpMethod,
} from '@mandate/connector-sdk';
import type { ConnectionClient } from '../http/client.js';
import { FORBIDDEN_HEADERS } from '../http/headers.js';
import type { HttpRequestSpec } from '../openapi/request.js';

const METHODS: ReadonlySet<string> = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** Starts with `/`; no query, fragment, whitespace or backslash. */
const PATH = /^\/[^?#\s\\]*$/;
const MAX_PATH_LENGTH = 2048;
/** RFC 9110 §5.6.2 token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

/** Thrown by the pre-send hook of a write whose signal aborted while it waited (F26). */
class CodeSendAborted extends Error {
  override readonly name = 'CodeSendAborted';
}

const MAPPING: CodeHttpResponse = Object.freeze({ ok: false, code: 'mapping' });
const BUSY: CodeHttpResponse = Object.freeze({ ok: false, code: 'busy' });
const TIMEOUT: CodeHttpResponse = Object.freeze({ ok: false, code: 'timeout' });

type Scalar = string | number | boolean;
const isScalar = (v: unknown): v is Scalar => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const isDotSegment = (v: string): boolean => v === '.' || v === '..';
const isMethod = (m: unknown): m is HttpMethod => typeof m === 'string' && METHODS.has(m);

/**
 * True when the path is safe to append to the base URL: the shape above, not protocol-relative,
 * and no segment is a dot segment raw or after decoding (a decode failure is unsafe). A segment
 * whose decoded form contains `/` or `\` is checked part by part, since an upstream may decode it.
 */
function safePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH || !PATH.test(path) || path.startsWith('//')) return false;
  for (const segment of path.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (isDotSegment(segment) || decoded.split(/[/\\]/).some(isDotSegment)) return false;
  }
  return true;
}

/** The query as repeated parameters; undefined when a value is not a `CodeQueryValue`. */
function queryPairs(query: unknown): [string, string][] | undefined {
  if (query === undefined) return [];
  if (!isPlainRecord(query)) return undefined;
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(query)) {
    if (isScalar(value)) pairs.push([key, String(value)]);
    else if (Array.isArray(value) && value.every(isScalar)) for (const v of value) pairs.push([key, String(v)]);
    else return undefined;
  }
  return pairs;
}

/**
 * The code's headers, lower-cased; undefined when a name or value is invalid. Credential and
 * transport headers and the connection's API key header are dropped: the client sets the auth
 * header itself, last (SEC-2, F21).
 */
function codeHeaders(headers: unknown, connection: ConnectionSettings): Record<string, string> | undefined {
  if (headers === undefined) return {};
  if (!isPlainRecord(headers)) return undefined;
  const apiKeyHeader = connection.auth?.scheme === 'api_key' ? connection.auth.header.toLowerCase() : undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || !HEADER_VALUE.test(value)) return undefined;
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower) || lower === apiKeyHeader) continue;
    out[lower] = value;
  }
  return out;
}

/** The request as the connection client takes it; undefined when any rule is broken. */
function toSpec(request: unknown, connection: ConnectionSettings): HttpRequestSpec | undefined {
  if (!isPlainRecord(request)) return undefined;
  const { method, path } = request;
  if (!isMethod(method) || !safePath(path)) return undefined;
  if (/[?#]/.test(connection.baseUrl)) return undefined;
  const pairs = queryPairs(request.query);
  const headers = codeHeaders(request.headers, connection);
  if (pairs === undefined || headers === undefined) return undefined;
  let url: URL;
  let base: URL;
  try {
    base = new URL(connection.baseUrl);
    url = new URL(connection.baseUrl.replace(/\/+$/, '') + path);
  } catch {
    return undefined;
  }
  // Defence in depth: the path rules above already keep the request on the base URL's origin.
  if (url.origin !== base.origin) return undefined;
  for (const [key, value] of pairs) url.searchParams.append(key, value);
  const spec: HttpRequestSpec = { method, url, headers: { accept: 'application/json', ...headers } };
  if (request.body !== undefined) {
    let body: string | undefined;
    try {
      // JSON.stringify answers undefined for a function or symbol; its declared type omits that.
      const text = JSON.stringify(request.body) as string | undefined;
      body = text;
    } catch {
      return undefined;
    }
    // A function or symbol body serialises to nothing.
    if (body === undefined) return undefined;
    spec.body = body;
    spec.headers['content-type'] = 'application/json';
  }
  return spec;
}

export function createCodeHttpClient(input: {
  client: ConnectionClient;
  connection: ConnectionSettings;
  credential?: CredentialSource;
  signal: AbortSignal;
  maxRequests: number;
  onSend?: () => void;
}): CodeHttpClient {
  const { client, connection, credential, signal, maxRequests, onSend } = input;
  let calls = 0;

  async function send(request: CodeHttpRequest): Promise<CodeHttpResponse> {
    // After the deadline (or once the operation finished) nothing more is sent (F26).
    if (signal.aborted) return TIMEOUT;
    calls += 1;
    if (calls > maxRequests) return BUSY;
    const spec = toSpec(request, connection);
    if (spec === undefined) return MAPPING;
    onSend?.();
    const auth = credential === undefined ? {} : { credential };
    let r: Awaited<ReturnType<ConnectionClient['send']>>;
    if (spec.method === 'GET') {
      // Only GET is retried (CONN-6). A read may still leave after the deadline (credential, slot
      // or retry wait); it changes nothing upstream and its answer reaches no one.
      r = await client.send(spec, { retryable: true, ...auth });
    } else {
      // A write is sent once (EXE-4). It may wait for the credential and a connection slot; the hook
      // runs immediately before it leaves, so a write still waiting at the deadline is never sent (F26).
      try {
        r = await client.send(spec, {
          retryable: false,
          beforeSend: () => (signal.aborted ? Promise.reject(new CodeSendAborted()) : Promise.resolve()),
          ...auth,
        });
      } catch (err) {
        if (err instanceof CodeSendAborted) return TIMEOUT;
        throw err;
      }
    }
    // `r.json` is already scrubbed by the client; a failure carries its code and status, never the message (SEC-3).
    if (r.ok) return { ok: true, status: r.status, json: r.json };
    return { ok: false, code: r.code, ...(r.status === undefined ? {} : { status: r.status }) };
  }

  // Only `send` is visible to the code: the client, credential and counters stay in this closure.
  return Object.freeze({ send });
}
