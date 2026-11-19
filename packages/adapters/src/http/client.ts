import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import {
  parseSecret,
  type ConnectionSettings,
  type CredentialSource,
  type ReadErrorCode,
  type RequestAttemptEnd,
  type RequestInstrumentation,
  type RequestSpan,
} from '@aiops/connector-sdk';
import type { HttpRequestSpec } from '../openapi/request.js';
import { assertEgressAllowed, createGuardedLookup, EgressDeniedError } from './egress.js';
import { clientCredentialsToken, clientSecretBasicValue, HEADER_SAFE } from './oauth.js';
import { createScrubber, type Scrubber } from './scrub.js';
import { semaphoreFor } from './semaphore.js';

/** Response body limit (spec §4.5). */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Upper bound for an honoured `Retry-After` (spec §4.5). */
export const MAX_RETRY_AFTER_MS = 10_000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Outcome of one HTTP exchange, before credential and retry handling. Carries no request headers. */
export type RawResult =
  | { kind: 'response'; status: number; headers: IncomingHttpHeaders; json: unknown }
  | { kind: 'status'; status: number; headers: IncomingHttpHeaders }
  | { kind: 'error'; code: 'timeout' | 'network' | 'egress_denied' | 'invalid_response'; message: string };

/** One guarded HTTP exchange with a per-attempt timeout. Never follows redirects. */
export type Transport = (spec: HttpRequestSpec, timeoutMs: number) => Promise<RawResult>;

export type SendResult =
  | { ok: true; status: number; json: unknown; durationMs: number }
  | { ok: false; code: ReadErrorCode; status?: number; durationMs: number; message: string };

export interface SendOptions {
  credential?: CredentialSource;
  /** Reads only: retries on connection errors, timeouts, 429, 502, 503, 504 (CONN-6). */
  retryable: boolean;
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
function hookHeaders(span: RequestSpan, taken: ReadonlySet<string>): Record<string, string> {
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

function isJsonContentType(value: string | undefined): boolean {
  const ct = (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return ct === 'application/json' || /^application\/[a-z0-9.!#$&^_-]+\+json$/.test(ct);
}

function networkMessage(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' && /^[A-Z_]{2,40}$/.test(err.code) ? err.code : 'unknown';
  return `network error (${code})`;
}

/** Guarded transport: pre-connect host check, guarded lookup, timeout, JSON-only 2xx bodies up to 5 MB. */
export function createTransport(settings: ConnectionSettings, lookup: LookupFunction): Transport {
  return (spec, timeoutMs) => {
    const url = spec.url;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return Promise.resolve({ kind: 'error', code: 'egress_denied', message: 'unsupported URL scheme' });
    }
    try {
      // Node skips `lookup` for IP literals, so the host is checked here before every request.
      assertEgressAllowed(settings, url.hostname);
    } catch (err) {
      const message = err instanceof EgressDeniedError ? err.message : 'egress denied';
      return Promise.resolve({ kind: 'error', code: 'egress_denied', message });
    }
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
        if (status === 204) {
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
    let scrubber: Scrubber = createScrubber([]);
    const fail = (code: ReadErrorCode, message: string, status?: number): SendResult => ({
      ok: false,
      code,
      ...(status === undefined ? {} : { status }),
      durationMs: Math.max(0, now() - start),
      message: scrubber.text(message),
    });

    const auth = settings.auth;
    const secrets: string[] = [];
    let authHeader: [string, string] | undefined;
    let oauth: { tokenUrl: string; clientId: string; clientSecret: string; scopes: readonly string[]; timeoutMs: number } | undefined;

    if (auth) {
      const credential = opts.credential;
      if (!credential) return fail('credential_missing', `connection ${settings.id} has no credential`);
      if (credential.scheme !== auth.scheme) return fail('credential_unusable', `credential scheme does not match connection ${settings.id}`);
      let opened: Readonly<Record<string, string>>;
      try {
        opened = await credential.open();
      } catch {
        return fail('credential_unusable', `credential ${credential.ref} could not be opened`);
      }
      const parsed = parseSecret(auth.scheme, opened);
      if (!parsed.ok) {
        // Scrub whatever we were handed even though the material is unusable.
        scrubber = createScrubber(Object.values(opened).filter((v): v is string => typeof v === 'string'));
        return fail('credential_unusable', parsed.message);
      }
      const s = parsed.secret;
      // A Basic user name is an identifier, not a secret: scrubbing it would redact ordinary
      // response data ("admin"). The password and the encoded pair are scrubbed.
      secrets.push(...Object.entries(s).filter(([k]) => !(auth.scheme === 'basic' && k === 'username')).map(([, v]) => v));
      const unsendable = (): SendResult => fail('credential_unusable', `credential ${credential.ref} contains characters not allowed in a header`);
      switch (auth.scheme) {
        case 'bearer':
          if (!HEADER_SAFE.test(s.token ?? '')) return unsendable();
          authHeader = ['authorization', `Bearer ${s.token ?? ''}`];
          break;
        case 'api_key':
          if (!HEADER_SAFE.test(s.key ?? '')) return unsendable();
          authHeader = [auth.header.toLowerCase(), s.key ?? ''];
          break;
        case 'basic': {
          const value = Buffer.from(`${s.username ?? ''}:${s.password ?? ''}`).toString('base64');
          // Base64 is always visible ASCII; checked anyway so the rule is the same for every scheme.
          if (!HEADER_SAFE.test(value)) return unsendable();
          secrets.push(value);
          authHeader = ['authorization', `Basic ${value}`];
          break;
        }
        case 'oauth_client_credentials': {
          const clientId = s.client_id ?? '';
          const clientSecret = s.client_secret ?? '';
          secrets.push(Buffer.from(`${clientId}:${clientSecret}`).toString('base64'));
          // The exact value sent to the token endpoint (form-encoded id and secret, RFC 6749 §2.3.1).
          secrets.push(clientSecretBasicValue(clientId, clientSecret));
          oauth = { tokenUrl: auth.tokenUrl, clientId, clientSecret, scopes: auth.scopes, timeoutMs: settings.timeoutMs };
          break;
        }
      }
      scrubber = createScrubber(secrets);
    }

    let currentToken: string | undefined;
    const useToken = async (rejectedToken?: string): Promise<SendResult | undefined> => {
      if (!oauth) return undefined;
      const t = await clientCredentialsToken(settings.id, oauth, rejectedToken === undefined ? { now } : { now, rejectedToken }, transport);
      if (!t.ok) return fail(t.code, t.message, t.status);
      secrets.push(t.accessToken);
      scrubber = createScrubber(secrets);
      currentToken = t.accessToken;
      authHeader = ['authorization', `Bearer ${t.accessToken}`];
      return undefined;
    };
    const tokenFailure = await useToken();
    if (tokenFailure) return tokenFailure;

    const semaphore = semaphoreFor(settings.id, settings.maxConcurrency);
    const attemptOnce = async (): Promise<RawResult | 'busy'> => {
      const waitStart = now();
      const release = await semaphore.acquire(settings.timeoutMs);
      if (!release) return 'busy';
      try {
        // Waiting for the slot counts against the timeout (CONN-6).
        const remaining = Math.max(1, settings.timeoutMs - Math.max(0, now() - waitStart));
        const headers: Record<string, string> = { ...req.headers };
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
            if (authHeader) taken.add(authHeader[0].toLowerCase());
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
          result = await transport({ ...req, headers }, remaining);
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

    const maxAttempts = opts.retryable ? Math.max(1, settings.retry.maxAttempts) : 1;
    let refreshed = false;
    let retries = 0;
    for (;;) {
      const r = await attemptOnce();
      if (r === 'busy') return fail('busy', `connection ${settings.id} has no free slot within ${settings.timeoutMs} ms`);
      if (r.kind === 'response') {
        return { ok: true, status: r.status, json: scrubber.deep(r.json), durationMs: Math.max(0, now() - start) };
      }
      if (r.kind === 'status' && r.status === 401 && oauth && !refreshed) {
        // The cached token may have been revoked or expired early: refresh once (spec §4.5).
        // Passing the rejected token lets a concurrent call that already refreshed win (no second fetch).
        refreshed = true;
        const refreshFailure = await useToken(currentToken);
        if (refreshFailure) return refreshFailure;
        continue;
      }
      const failure =
        r.kind === 'status' ? fail('http_status', `upstream returned status ${r.status}`, r.status) : fail(r.code, r.message);
      const retryable = r.kind === 'status' ? RETRYABLE_STATUS.has(r.status) : r.code === 'timeout' || r.code === 'network';
      if (!retryable || retries + 1 >= maxAttempts) return failure;
      const hinted = r.kind === 'status' ? retryAfterMs(r.headers, now) : undefined;
      const backoff = hinted ?? settings.retry.initialBackoffMs * 2 ** retries * random();
      retries += 1;
      await sleep(backoff);
    }
  }

  return { send };
}
