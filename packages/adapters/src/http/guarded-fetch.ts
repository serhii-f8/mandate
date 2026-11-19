import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { ConnectionSettings, RequestAttemptEnd, RequestInstrumentation, RequestSpan } from '@aiops/connector-sdk';
import type { PreparedAuth } from './auth.js';
import { hookHeaders, isJsonContentType, MAX_RESPONSE_BYTES, mediaType, networkMessage } from './client.js';
import { assertEgressAllowed, createGuardedLookup, EgressDeniedError } from './egress.js';
import { FORBIDDEN_HEADERS } from './headers.js';
import type { Scrubber } from './scrub.js';

/** Largest non-2xx body handed to the SDK (R7); a larger one is dropped. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

export type GuardedFailureCode = 'timeout' | 'network' | 'egress_denied' | 'invalid_response' | 'http_status';

export interface GuardedFailure {
  code: GuardedFailureCode;
  status?: number;
  message: string;
}

/** A guarded failure of one exchange; the message is scrubbed and carries no upstream text (SEC-3). */
export class GuardedFetchError extends Error {
  readonly code: GuardedFailureCode;
  constructor(code: GuardedFailureCode, message: string) {
    super(message);
    this.name = 'GuardedFetchError';
    this.code = code;
  }
}

export interface GuardedFetch {
  /** The `fetch` handed to StreamableHTTPClientTransport. Throws GuardedFetchError on a guarded failure. */
  readonly fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /**
   * The most recent guarded failure of this fetch's lifetime (status set for http_status), or
   * undefined when there was none. Era negotiation produces expected non-2xx exchanges, so the
   * adapter uses it only when the SDK's error comes from the transport (ruling F8).
   */
  lastFailure(): GuardedFailure | undefined;
  readonly scrubber: Scrubber;
}

export interface GuardedFetchDeps {
  lookup?: LookupFunction;
  /** Optional hook around each exchange (NFR-11); one span per exchange, never around a token fetch. */
  instrumentation?: RequestInstrumentation;
  /** Refresh an OAuth token once after a 401 and resend (default true). */
  refreshOn401?: boolean;
}

/** Response headers that describe the upstream framing, not the body handed on. */
const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'set-cookie']);
function abortReason(signal: AbortSignal): Error {
  // A plain abort() sets a DOMException named AbortError, as fetch rejects with.
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException('This operation was aborted', 'AbortError');
}

function requestBody(body: RequestInit['body']): Buffer | undefined | 'unsupported' {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  // The SDK sends JSON strings; streams, forms and blobs are not needed and not supported.
  return 'unsupported';
}

function responseHeaders(raw: IncomingHttpHeaders, scrubber: Scrubber): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name)) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      try {
        out.append(name, scrubber.text(v));
      } catch {
        // A value the web Headers refuses is dropped; node already rejected malformed framing.
      }
    }
  }
  return out;
}

/**
 * The `fetch` of the MCP transport (CONN-5, CONN-6, SEC-3): egress check and guarded lookup, no
 * redirects, a per-exchange timeout that runs until the body ends, a 5 MB body cap, 2xx bodies of
 * JSON or SSE only, the credential header set last, one instrumentation span per exchange, a local
 * 405 for GET (R6), non-2xx JSON bodies up to 64 KiB passed on (R7), and scrubbed messages.
 */
export function createGuardedFetch(settings: ConnectionSettings, auth: PreparedAuth, deps: GuardedFetchDeps = {}): GuardedFetch {
  const lookup = deps.lookup ?? createGuardedLookup(settings);
  const refreshOn401 = deps.refreshOn401 ?? true;
  const instrumentation = deps.instrumentation;
  let last: GuardedFailure | undefined;

  const record = (code: GuardedFailureCode, message: string, status?: number): GuardedFailure => {
    last = { code, ...(status === undefined ? {} : { status }), message: auth.scrubber.text(message) };
    return last;
  };
  const failure = (code: GuardedFailureCode, message: string): GuardedFetchError => new GuardedFetchError(code, record(code, message).message);

  /** One exchange: resolves with a web Response or rejects with GuardedFetchError (or the abort reason). */
  function exchange(url: URL, method: 'POST' | 'DELETE', base: Readonly<Record<string, string>>, body: Buffer | undefined, signal: AbortSignal | undefined): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      // The signal may have aborted since the caller's check (e.g. during a token refresh): nothing is sent.
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const headers: Record<string, string> = { ...base };
      let span: RequestSpan | undefined;
      if (instrumentation) {
        try {
          span = instrumentation.start({ connection: settings.id, method, host: url.hostname });
        } catch {
          span = undefined;
        }
        if (span) {
          const taken = new Set(Object.keys(headers));
          const authName = auth.header()?.[0];
          if (authName !== undefined) taken.add(authName.toLowerCase());
          try {
            Object.assign(headers, hookHeaders(span, taken));
          } catch {
            // No extra headers.
          }
        }
      }
      const authHeader = auth.header();
      // Set last: nothing from init or the hook can replace it (CONN-3).
      if (authHeader) headers[authHeader[0].toLowerCase()] = authHeader[1];
      if (body !== undefined) headers['content-length'] = String(body.length);

      const endSpan = (end: RequestAttemptEnd): void => {
        const s = span;
        span = undefined;
        if (!s) return;
        try {
          s.end(end);
        } catch {
          // An instrumentation failure never changes the exchange.
        }
      };

      let phase: 'headers' | 'body' | 'done' = 'headers';
      let res: IncomingMessage | undefined;
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;

      const cleanup = (): void => {
        phase = 'done';
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      /** Ends the exchange before a Response was handed on. */
      const rejectWith = (err: Error, end: RequestAttemptEnd): void => {
        if (phase !== 'headers') return;
        cleanup();
        endSpan(end);
        req.destroy();
        res?.destroy();
        reject(err);
      };
      const resolveWith = (response: Response, end: RequestAttemptEnd): void => {
        if (phase !== 'headers') return;
        cleanup();
        endSpan(end);
        resolve(response);
      };
      /** Errors a streamed body that was already handed on. */
      const errorBody = (err: Error, end: RequestAttemptEnd): void => {
        if (phase !== 'body') return;
        cleanup();
        endSpan(end);
        res?.destroy();
        try {
          bodyController?.error(err);
        } catch {
          // Already closed or cancelled by the reader.
        }
      };
      const fail = (code: Exclude<GuardedFailureCode, 'http_status'>, message: string): void => {
        if (phase === 'headers') rejectWith(failure(code, message), { errorCode: code });
        else if (phase === 'body') errorBody(failure(code, message), { errorCode: code });
      };
      function onAbort(): void {
        if (!signal) return;
        if (phase === 'headers') rejectWith(abortReason(signal), { errorCode: 'network' });
        else errorBody(abortReason(signal), { errorCode: 'network' });
      }

      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      let req: ReturnType<typeof send>;
      try {
        req = send(url, { method, headers, lookup, agent: false }, onResponse);
      } catch {
        // Node validates header names and values synchronously; no timer or listener exists yet.
        phase = 'done';
        endSpan({ errorCode: 'network' });
        reject(failure('network', 'request could not be built (invalid header)'));
        return;
      }
      const timer = setTimeout(() => {
        fail('timeout', `upstream did not answer within ${settings.timeoutMs} ms`);
      }, Math.max(1, settings.timeoutMs));
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', (err) => {
        if (err instanceof EgressDeniedError) fail('egress_denied', err.message);
        else fail('network', networkMessage(err));
      });

      function onResponse(incoming: IncomingMessage): void {
        res = incoming;
        const status = incoming.statusCode ?? 0;
        const scrubber = auth.scrubber;
        if (status >= 300 && status < 400) {
          // Redirects are never followed, and their target is never contacted (CONN-5).
          fail('egress_denied', `upstream redirected (status ${status}); redirects are not followed`);
          return;
        }
        if (status < 200 || status > 599) {
          fail('invalid_response', `upstream returned an unusable status ${status}`);
          return;
        }
        const ct = mediaType(incoming.headers['content-type']);
        const declared = Number(incoming.headers['content-length']);
        if (status >= 400) {
          readErrorBody(incoming, status, ct, declared, scrubber);
          return;
        }
        if (status === 202 || status === 204) {
          incoming.destroy();
          resolveWith(new Response(null, { status, headers: responseHeaders(incoming.headers, scrubber) }), { status });
          return;
        }
        if (!isJsonContentType(ct) && ct !== 'text/event-stream') {
          fail('invalid_response', 'upstream response is neither JSON nor an event stream');
          return;
        }
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
          fail('invalid_response', 'upstream response exceeds 5 MB');
          return;
        }
        streamBody(incoming, status, scrubber);
      }

      function streamBody(incoming: IncomingMessage, status: number, scrubber: Scrubber): void {
        let size = 0;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          },
          pull() {
            incoming.resume();
          },
          cancel() {
            // The reader gave up (the SDK closing): end the exchange quietly.
            if (phase !== 'body') return;
            cleanup();
            endSpan({ status });
            incoming.destroy();
          },
        });
        incoming.on('data', (chunk: Buffer) => {
          if (phase !== 'body') return;
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            fail('invalid_response', 'upstream response exceeds 5 MB');
            return;
          }
          bodyController?.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          if ((bodyController?.desiredSize ?? 0) <= 0) incoming.pause();
        });
        incoming.on('end', () => {
          if (phase !== 'body') return;
          cleanup();
          endSpan({ status });
          bodyController?.close();
        });
        incoming.on('error', (err) => {
          fail('network', networkMessage(err));
        });
        incoming.on('close', () => {
          // A no-op once `end` settled the body; otherwise the body was cut off.
          if (!incoming.complete) fail('network', 'upstream closed the response early');
        });
        // Handed on at the headers; the timer keeps running until the body ends (CONN-6).
        const response = new Response(stream, { status, headers: responseHeaders(incoming.headers, scrubber) });
        phase = 'body';
        resolve(response);
      }

      /** R7: a JSON body up to 64 KiB is passed on (scrubbed); any other body is dropped. */
      function readErrorBody(incoming: IncomingMessage, status: number, ct: string, declared: number, scrubber: Scrubber): void {
        const headers = responseHeaders(incoming.headers, scrubber);
        const empty = (): void => {
          headers.delete('content-type');
          incoming.destroy();
          resolveWith(new Response(null, { status, headers }), { status });
        };
        if (!isJsonContentType(ct) || (Number.isFinite(declared) && declared > MAX_ERROR_BODY_BYTES)) {
          empty();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ERROR_BODY_BYTES) {
            empty();
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            JSON.parse(text);
          } catch {
            empty();
            return;
          }
          resolveWith(new Response(scrubber.text(text), { status, headers }), { status });
        });
        incoming.on('error', (err) => {
          fail('network', networkMessage(err));
        });
        incoming.on('close', () => {
          if (!incoming.complete) fail('network', 'upstream closed the response early');
        });
      }

      req.end(body);
    });
  }

  async function guardedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw abortReason(signal);
    const method = (init.method ?? 'GET').toUpperCase();
    // R6: no standalone SSE stream; nothing else is sent by the transport.
    if (method !== 'POST' && method !== 'DELETE') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
    let url: URL;
    try {
      url = input instanceof URL ? new URL(input.href) : new URL(input);
    } catch {
      throw failure('egress_denied', 'request URL is not a valid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw failure('egress_denied', 'unsupported URL scheme');
    try {
      // Node skips `lookup` for IP literals, so the host is checked before every request.
      assertEgressAllowed(settings, url.hostname);
    } catch (err) {
      throw failure('egress_denied', err instanceof EgressDeniedError ? err.message : 'egress denied');
    }
    const body = requestBody(init.body);
    if (body === 'unsupported') throw failure('network', 'request body type is not supported');

    const base: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      // Credentials and framing are set here, never by the caller.
      if (FORBIDDEN_HEADERS.has(name) || name === 'accept-encoding') return;
      base[name] = value;
    });
    // Bodies are not decompressed here.
    base['accept-encoding'] = 'identity';

    let refreshed = false;
    for (;;) {
      const response = await exchange(url, method, base, body, signal);
      if (response.status === 401 && refreshOn401 && !refreshed) {
        refreshed = true;
        const refresh = await auth.refreshAfter401();
        if (refresh?.ok === true) continue;
        if (refresh) {
          record('http_status', `upstream returned status 401; token refresh failed: ${refresh.message}`, 401);
          return response;
        }
      }
      if (response.status >= 400) record('http_status', `upstream returned status ${response.status}`, response.status);
      return response;
    }
  }

  return {
    fetch: guardedFetch,
    lastFailure: () => (last === undefined ? undefined : { ...last }),
    get scrubber() {
      return auth.scrubber;
    },
  };
}
