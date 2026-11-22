// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import {
  type ConnectionSettings,
  type CredentialSource,
  type ReadErrorCode,
  type RequestAttemptEnd,
  type RequestInstrumentation,
  type RequestSpan,
} from '@mandate/connector-sdk';
import type { HttpRequestSpec } from '../openapi/request.js';
import { assertEgressAllowed, createGuardedLookup, EgressDeniedError } from './egress.js';
import { prepareAuth } from './auth.js';
import { pacerFor } from './pacer.js';
import { semaphoreFor } from './semaphore.js';

/** Response body limit (spec §4.5). */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Upper bound for an honoured `Retry-After` (spec §4.5). */
export const MAX_RETRY_AFTER_MS = 10_000;
/** HTTP statuses a read is retried on (CONN-6, R5); shared with the MCP adapter. */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/** Outcome of one HTTP exchange, before credential and retry handling. Carries no request headers. */
export type RawResult =
  | { kind: 'response'; status: number; headers: IncomingHttpHeaders; json: unknown }
  | { kind: 'status'; status: number; headers: IncomingHttpHeaders }
  | { kind: 'error'; code: 'timeout' | 'network' | 'egress_denied' | 'invalid_response'; message: string };

export interface TransportOptions {
  /** Any 2xx finishes on its headers as `json: null`; the body is destroyed unread (SEC-3, EXE-4). */
  readonly discardBody?: boolean;
}

/** One guarded HTTP exchange with a per-attempt timeout. Never follows redirects. */
export type Transport = (spec: HttpRequestSpec, timeoutMs: number, opts?: TransportOptions) => Promise<RawResult>;

export type SendResult =
  | { ok: true; status: number; json: unknown; durationMs: number }
  | { ok: false; code: ReadErrorCode; status?: number; durationMs: number; message: string };

export interface SendOptions {
  credential?: CredentialSource;
  /** Reads only: retries on connection errors, timeouts, 429, 502, 503, 504 (CONN-6). */
  retryable: boolean;
  /**
   * Called once, after the credential, the semaphore slot and the host allow-list check,
   * immediately before the single transport call (EXE-4). A throw releases the slot and is
   * rethrown; nothing is sent. With it the client never retries and never resends after a 401.
   */
  beforeSend?: () => Promise<void>;
  /** A 2xx answers `json: null` without reading the body (see `TransportOptions.discardBody`). */
  discardBody?: boolean;
}

export interface ConnectionClient {
  send(req: HttpRequestSpec, opts: SendOptions): Promise<SendResult>;
}

export interface ConnectionClientDeps {
  lookup?: LookupFunction;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Optional hook around each upstream attempt (NFR-11); never around the OAuth token fetch. */
  readonly instrumentation?: RequestInstrumentation;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * A hook header value: visible ASCII with internal spaces allowed (a W3C `tracestate` member value
 * may contain one), never CR/LF, tab or other controls, never a leading or trailing space.
 */
const HOOK_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** The only headers the request hook may add: W3C trace context (NFR-11). */
const HOOK_HEADERS: ReadonlySet<string> = new Set(['traceparent', 'tracestate']);

/**
 * The hook's headers that may be added to the request: `traceparent` and `tracestate` only (any
 * case), with a valid value, never the auth header or a header the request already carries
 * (SEC-3). Throws only if the hook's object does.
 */
export function hookHeaders(span: RequestSpan, taken: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  const raw: unknown = span.headers;
  // A string or array would yield index names ('0', '1', ...): only a plain object is read.
  if (!isPlainRecord(raw)) return out;
  for (const [rawName, value] of Object.entries(raw)) {
    const name = rawName.toLowerCase();
    if (!HOOK_HEADERS.has(name) || typeof value !== 'string' || !HOOK_VALUE.test(value)) continue;
    if (taken.has(name) || Object.hasOwn(out, name)) continue;
    out[name] = value;
  }
  return out;
}

function endOf(r: RawResult): RequestAttemptEnd {
  return r.kind === 'error' ? { errorCode: r.code } : { status: r.status };
}

/** The media type of a `content-type` value, lower-case, without parameters. */
export function mediaType(value: string | undefined): string {
  return (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** True for `application/json` and `application/*+json` (any parameters). */
export function isJsonContentType(value: string | undefined): boolean {
  const ct = mediaType(value);
  return ct === 'application/json' || /^application\/[a-z0-9.!#$&^_-]+\+json$/.test(ct);
}

/** A fixed network message naming only the error code (SEC-3). */
export function networkMessage(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' && /^[A-Z_]{2,40}$/.test(err.code) ? err.code : 'unknown';
  return `network error (${code})`;
}

/** The scheme and host allow-list check of a request URL (CONN-5); undefined when allowed. */
function egressRefusal(settings: ConnectionSettings, url: URL): RawResult | undefined {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'error', code: 'egress_denied', message: 'unsupported URL scheme' };
  }
  try {
    // Node skips `lookup` for IP literals, so the host is checked here before every request.
    assertEgressAllowed(settings, url.hostname);
  } catch (err) {
    const message = err instanceof EgressDeniedError ? err.message : 'egress denied';
    return { kind: 'error', code: 'egress_denied', message };
  }
  return undefined;
}

/** Guarded transport: pre-connect host check, guarded lookup, timeout, JSON-only 2xx bodies up to 5 MB. */
export function createTransport(settings: ConnectionSettings, lookup: LookupFunction): Transport {
  return (spec, timeoutMs, opts = {}) => {
    const url = spec.url;
    const refused = egressRefusal(settings, url);
    if (refused) return Promise.resolve(refused);
    return new Promise<RawResult>((resolve) => {
      let settled = false;
      const headers: Record<string, string> = { ...spec.headers };
      if (spec.body !== undefined) headers['content-length'] = String(Buffer.byteLength(spec.body));
      const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
      let req: ReturnType<typeof request>;
      try {
        req = request(url, { method: spec.method, headers, lookup, agent: false }, onResponse);
      } catch {
        // Node validates header names and values synchronously (ERR_INVALID_CHAR and friends).
        resolve({ kind: 'error', code: 'network', message: 'request could not be built (invalid header)' });
        return;
      }
      function onResponse(res: IncomingMessage): void {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          // Redirects (3xx) are not followed (CONN-5); error bodies are never read (SEC-3).
          finish({ kind: 'status', status, headers: res.headers });
          res.destroy();
          return;
        }
        if (status === 204 || opts.discardBody === true) {
          finish({ kind: 'response', status, headers: res.headers, json: null });
          res.destroy();
          return;
        }
        if (!isJsonContentType(res.headers['content-type'])) {
          finish({ kind: 'error', code: 'invalid_response', message: 'upstream response is not JSON' });
          res.destroy();
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
          finish({ kind: 'error', code: 'invalid_response', message: 'upstream response exceeds 5 MB' });
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish({ kind: 'error', code: 'invalid_response', message: 'upstream response exceeds 5 MB' });
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            finish({ kind: 'response', status, headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
          } catch {
            finish({ kind: 'error', code: 'invalid_response', message: 'upstream response is not valid JSON' });
          }
        });
        res.on('error', (err) => {
          finish({ kind: 'error', code: 'network', message: networkMessage(err) });
        });
        res.on('close', () => {
          // A no-op once `end` already settled the result; otherwise the body was cut off.
          if (!res.complete) finish({ kind: 'error', code: 'network', message: 'upstream closed the response early' });
        });
      }
      const timer = setTimeout(() => {
        finish({ kind: 'error', code: 'timeout', message: `upstream did not answer within ${timeoutMs} ms` });
        req.destroy();
      }, Math.max(1, timeoutMs));
      function finish(r: RawResult): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }
      req.on('error', (err) => {
        if (err instanceof EgressDeniedError) finish({ kind: 'error', code: 'egress_denied', message: err.message });
        else finish({ kind: 'error', code: 'network', message: networkMessage(err) });
      });
      if (spec.body !== undefined) req.end(spec.body);
      else req.end();
    });
  };
}

function retryAfterMs(headers: IncomingHttpHeaders, now: () => number): number | undefined {
  const raw = headers['retry-after'];
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const v = raw.trim();
  let ms: number;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else {
    const at = Date.parse(v);
    if (Number.isNaN(at)) return undefined;
    ms = Math.max(0, at - now());
  }
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/**
 * HTTP client for one connection (CONN-3, CONN-6): opens the credential inside the call and injects
 * it per scheme, applies the egress guard (CONN-5), the per-connection semaphore, per-attempt
 * timeouts and read retries, and scrubs every string that leaves it (SEC-3).
 */
export function createConnectionClient(settings: ConnectionSettings, deps: ConnectionClientDeps = {}): ConnectionClient {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const instrumentation = deps.instrumentation;
  const transport = createTransport(settings, deps.lookup ?? createGuardedLookup(settings));

  async function send(req: HttpRequestSpec, opts: SendOptions): Promise<SendResult> {
    const start = now();
    const prepared = await prepareAuth(settings, opts.credential, { now, transport });
    // Its message is already scrubbed: returned as is, with the time spent so far.
    if (!prepared.ok) return { ...prepared, durationMs: Math.max(0, now() - start) };
    const auth = prepared.auth;
    const fail = (code: ReadErrorCode, message: string, status?: number): SendResult => ({
      ok: false,
      code,
      ...(status === undefined ? {} : { status }),
      durationMs: Math.max(0, now() - start),
      message: auth.scrubber.text(message),
    });

    const semaphore = semaphoreFor(settings.id, settings.maxConcurrency);
    // Also for a connection without a rate: an honoured Retry-After holds the whole connection.
    const pacer = pacerFor(settings.id, settings.minIntervalMs);
    const transportOpts: TransportOptions = opts.discardBody === true ? { discardBody: true } : {};
    const beforeSend = opts.beforeSend;
    const attemptOnce = async (): Promise<RawResult | 'busy'> => {
      const waitStart = now();
      const release = await semaphore.acquire(settings.timeoutMs);
      if (!release) return 'busy';
      try {
        // Waiting for the slot counts against the timeout (CONN-6); the hook's own time does not.
        const remaining = Math.max(1, settings.timeoutMs - Math.max(0, now() - waitStart));
        // Pacing (CONN-6): the slot is booked per attempt, retries included; the wait does not count
        // against the attempt's own timeout. A slot further away than the timeout is `busy`.
        const paceWait = pacer.reserve(now(), settings.timeoutMs);
        if (paceWait === undefined) return 'busy';
        if (paceWait > 0) await sleep(paceWait);
        if (beforeSend) {
          // The allow-list refuses before the hook, so a refused call records nothing (R4, F4); the
          // transport checks again. The resolved address is still checked at connect.
          const refused = egressRefusal(settings, req.url);
          if (refused) return refused;
          await beforeSend();
        }
        const headers: Record<string, string> = { ...req.headers };
        // Signed per attempt, over the exact URL the transport sends: a retry has a fresh nonce.
        const authHeader = auth.header({ method: req.method, url: req.url });
        let span: RequestSpan | undefined;
        if (instrumentation) {
          // A failing hook leaves the request exactly as without one: a throwing `start` gives no
          // headers and no `end`; unreadable span headers give no headers, and the span still ends.
          try {
            span = instrumentation.start({ connection: settings.id, method: req.method, host: req.url.hostname });
          } catch {
            span = undefined;
          }
          if (span) {
            const taken = new Set(Object.keys(req.headers).map((n) => n.toLowerCase()));
            if (authHeader !== undefined) taken.add(authHeader[0].toLowerCase());
            try {
              Object.assign(headers, hookHeaders(span, taken));
            } catch {
              // No extra headers.
            }
          }
        }
        if (authHeader) headers[authHeader[0]] = authHeader[1];
        let result: RawResult | undefined;
        try {
          result = await transport({ ...req, headers }, remaining, transportOpts);
          return result;
        } finally {
          if (span) {
            try {
              // A transport that rejected (it never should) still ends the span, as a network error.
              span.end(result ? endOf(result) : { errorCode: 'network' });
            } catch {
              // An instrumentation failure never changes the request's outcome.
            }
          }
        }
      } finally {
        release();
      }
    };

    // A call with a pre-send hook is sent at most once (EXE-4).
    const maxAttempts = opts.retryable && !beforeSend ? Math.max(1, settings.retry.maxAttempts) : 1;
    let retries = 0;
    for (;;) {
      const r = await attemptOnce();
      if (r === 'busy') return fail('busy', `connection ${settings.id} has no free slot within ${settings.timeoutMs} ms`);
      if (r.kind === 'response') {
        return { ok: true, status: r.status, json: auth.scrubber.deep(r.json), durationMs: Math.max(0, now() - start) };
      }
      // With a pre-send hook a 401 is the answer: a refreshed resend would be a second request.
      if (r.kind === 'status' && r.status === 401 && !beforeSend) {
        // OAuth only, once per send: the cached token may have been revoked or expired early.
        const refresh = await auth.refreshAfter401();
        if (refresh?.ok === true) continue;
        if (refresh) return { ...refresh, durationMs: Math.max(0, now() - start) };
      }
      // An honoured Retry-After holds every request of the connection, not only this call (CONN-6).
      const hinted = r.kind === 'status' && RETRYABLE_STATUS.has(r.status) ? retryAfterMs(r.headers, now) : undefined;
      if (hinted !== undefined) pacer.holdUntil(now() + hinted);
      const failure =
        r.kind === 'status' ? fail('http_status', `upstream returned status ${r.status}`, r.status) : fail(r.code, r.message);
      const retryable = r.kind === 'status' ? RETRYABLE_STATUS.has(r.status) : r.code === 'timeout' || r.code === 'network';
      if (!retryable || retries + 1 >= maxAttempts) return failure;
      const backoff = hinted ?? settings.retry.initialBackoffMs * 2 ** retries * random();
      retries += 1;
      await sleep(backoff);
    }
  }

  return { send };
}
