/**
 * OpenAPI adapter facade (CONN-2, CONN-7, SEC-7): the spec resolver the configuration loader uses,
 * the read path the api uses, scope detection for the connection test, and the bulk write path the
 * worker uses (OPS-6, EXE-4).
 */
import {
  parseSecret,
  type BulkStatusOutcome,
  type BulkSubmitOutcome,
  type ConnectionSettings,
  type CredentialSource,
  type HttpMethod,
  type ReadAdapter,
  type ReadOutcome,
  type RequestInstrumentation,
  type ScopeReport,
  type SpecIssue,
  type UpstreamMapping,
  type UpstreamResolver,
  type WriteAdapter,
  type WriteFailure,
} from '@aiops/connector-sdk';
import { createConnectionClient, createTransport, type ConnectionClient, type SendResult, type Transport } from '../http/client.js';
import { createGuardedLookup } from '../http/egress.js';
import { clientCredentialsToken, lastTokenScopes } from '../http/oauth.js';
import { buildBulkBody, extractBatchId, isSafeBatchId, mapBulkStatus } from './bulk.js';
import { deriveCatalog } from './derive.js';
import { normaliseSpec, validateSpecDocument } from './normalise.js';
import { buildRequest, MappingError, type HttpRequestSpec } from './request.js';
import { mapResponse } from './response.js';
import { isPlainObject } from './schema-translate.js';
import { fetchSpecUrl, loadSpecFile } from './spec-source.js';

export interface OpenApiAdapterDeps {
  /** Builds the HTTP client for a connection; defaults to `createConnectionClient`. */
  clientFor?: (settings: ConnectionSettings) => ConnectionClient;
  /** Transport for the OAuth token fetch of `detectScopes`; defaults to the guarded transport. */
  transportFor?: (settings: ConnectionSettings) => Transport;
  /** Hook around each upstream attempt of the default client, also for the spec fetch (NFR-11). With a custom `clientFor` the caller wires it. */
  readonly instrumentation?: RequestInstrumentation;
}

export type OpenApiAdapter = ReadAdapter & WriteAdapter & { resolver: UpstreamResolver };

const NOT_DETECTABLE: ScopeReport = { detectable: false, source: 'none', values: [] };
/** RFC 6749 §3.3 scope-token characters; anything else is not reported. */
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/;
const MAX_SCOPES = 200;
const B64URL = /^[A-Za-z0-9_-]+$/;
/** A JWT larger than this is not inspected. */
const MAX_JWT_LENGTH = 16_384;

const prefixSpecPath = (issues: readonly SpecIssue[]): SpecIssue[] =>
  issues.map((i) => (i.path[0] === 'openapi' ? i : { path: ['openapi', 'spec', ...i.path], message: i.message }));

function scopeValues(raw: unknown): string[] | undefined {
  let list: unknown[];
  if (typeof raw === 'string') list = raw.split(' ');
  else if (Array.isArray(raw)) list = raw;
  else return undefined;
  const values = list.filter((v): v is string => typeof v === 'string' && SCOPE_TOKEN.test(v));
  return [...new Set(values)].slice(0, MAX_SCOPES);
}

function decodeJsonPart(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * `scope` / `scp` claims of a JWT (decoded, not verified). Only the header (for `alg`) and the
 * payload are decoded; the signature is never touched and no part of the token is returned.
 */
export function jwtScopes(token: string): string[] | undefined {
  if (token.length > MAX_JWT_LENGTH) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [header, payload, signature] = parts;
  if (header === undefined || payload === undefined || signature === undefined) return undefined;
  if (!B64URL.test(header) || !B64URL.test(payload) || !B64URL.test(signature)) return undefined;
  const h = decodeJsonPart(header);
  if (!isPlainObject(h) || typeof h.alg !== 'string') return undefined;
  const p = decodeJsonPart(payload);
  if (!isPlainObject(p)) return undefined;
  const values = scopeValues(p.scope) ?? scopeValues(p.scp);
  return values && values.length > 0 ? values : undefined;
}

const mappingFailure = (): WriteFailure => ({ ok: false, code: 'mapping', durationMs: 0, retriable: false });

/**
 * Write outcome of a failed send. Carries no message: nothing from the upstream reaches a write
 * outcome (SEC-3, SEC-5). Retriable means the caller may try again: timeouts, network errors, a
 * full semaphore, HTTP 429 and 5xx. A submit answered with any other status was refused by the
 * upstream (`rejected`); a status poll keeps `http_status`.
 */
function classify(r: SendResult & { ok: false }, kind: 'submit' | 'status'): WriteFailure {
  const base = { ok: false as const, ...(r.status === undefined ? {} : { status: r.status }), durationMs: r.durationMs };
  if (r.code === 'http_status') {
    const retriable = r.status !== undefined && (r.status === 429 || r.status >= 500);
    return { ...base, code: retriable || kind === 'status' ? 'http_status' : 'rejected', retriable };
  }
  return { ...base, code: r.code, retriable: r.code === 'timeout' || r.code === 'network' || r.code === 'busy' };
}

async function openSecret(
  scheme: CredentialSource['scheme'],
  credential: CredentialSource | undefined,
): Promise<Readonly<Record<string, string>> | undefined> {
  if (credential?.scheme !== scheme) return undefined;
  try {
    const parsed = parseSecret(scheme, await credential.open());
    return parsed.ok ? parsed.secret : undefined;
  } catch {
    return undefined;
  }
}

export function createOpenApiAdapter(deps: OpenApiAdapterDeps = {}): OpenApiAdapter {
  const instrumentation = deps.instrumentation;
  const clientFor =
    deps.clientFor ?? ((s: ConnectionSettings) => createConnectionClient(s, instrumentation === undefined ? {} : { instrumentation }));
  const transportFor = deps.transportFor ?? ((s: ConnectionSettings) => createTransport(s, createGuardedLookup(s)));
  // One client per settings object: a reloaded configuration yields new settings and new clients;
  // the semaphore and token cache are per connection id inside the client modules.
  const clients = new WeakMap<ConnectionSettings, ConnectionClient>();
  const specClients = new WeakMap<ConnectionSettings, ConnectionClient>();

  const clientOf = (s: ConnectionSettings): ConnectionClient => {
    let c = clients.get(s);
    if (!c) {
      c = clientFor(s);
      clients.set(s, c);
    }
    return c;
  };

  /** Client for fetching the spec: same egress rules, but no credential is attached. */
  const specClientOf = (s: ConnectionSettings): ConnectionClient => {
    let c = specClients.get(s);
    if (!c) {
      const rest: ConnectionSettings = { ...s };
      delete rest.auth;
      delete rest.credentialRef;
      // Without `auth` the client sends no credential; the spec fetch never needs the token URL host.
      c = clientFor(rest);
      specClients.set(s, c);
    }
    return c;
  };

  const resolver: UpstreamResolver = {
    async resolveSpec({ connection, spec, include }) {
      const loaded = 'file' in spec ? await loadSpecFile(spec.file) : await fetchSpecUrl(specClientOf(connection), spec.url);
      if (!loaded.ok) return { ok: false, issues: loaded.issues };
      const invalid = await validateSpecDocument(loaded.doc);
      if (invalid.length > 0 || !isPlainObject(loaded.doc)) return { ok: false, issues: prefixSpecPath(invalid) };
      const normalised = normaliseSpec(loaded.doc);
      const derived = deriveCatalog(connection.id, normalised.operations, include);
      const issues = [...prefixSpecPath(normalised.issues), ...prefixSpecPath(derived.issues)];
      if (issues.length > 0) return { ok: false, issues };
      return { ok: true, catalog: derived.catalog };
    },
  };

  async function read(input: Parameters<ReadAdapter['read']>[0]): Promise<ReadOutcome> {
    const { connection, mapping, args, credential, exactValues } = input;
    const { method, path } = mapping;
    if (method === undefined || path === undefined) {
      return { ok: false, code: 'mapping', durationMs: 0, message: 'upstream mapping has no resolved method and path' };
    }
    let req: HttpRequestSpec;
    try {
      req = buildRequest(connection.baseUrl, { ...mapping, method, path }, args);
    } catch (err) {
      if (err instanceof MappingError) return { ok: false, code: 'mapping', durationMs: 0, message: err.message };
      throw err;
    }
    const r = await clientOf(connection).send(req, { retryable: method === 'GET', ...(credential ? { credential } : {}) });
    if (!r.ok) return r;
    // `r.json` is already scrubbed deep by the client (SEC-3); mapping only restructures and clips it (unless exact values are asked for).
    try {
      const mapped = mapResponse(mapping.response, r.json, args, exactValues === true ? { exactValues } : {});
      return { ok: true, status: r.status, durationMs: r.durationMs, ...mapped };
    } catch (err) {
      if (err instanceof MappingError) return { ok: false, code: 'mapping', status: r.status, durationMs: r.durationMs, message: err.message };
      throw err;
    }
  }

  async function detectScopes({ connection, credential }: Parameters<ReadAdapter['detectScopes']>[0]): Promise<ScopeReport> {
    const auth = connection.auth;
    if (auth?.scheme === 'bearer') {
      const secret = await openSecret('bearer', credential);
      const values = secret?.token === undefined ? undefined : jwtScopes(secret.token);
      return values ? { detectable: true, source: 'jwt_claims', values } : NOT_DETECTABLE;
    }
    if (auth?.scheme === 'oauth_client_credentials') {
      const secret = await openSecret('oauth_client_credentials', credential);
      if (secret?.client_id === undefined || secret.client_secret === undefined) return NOT_DETECTABLE;
      // Returns the cached token when there is one, so the recorded scope belongs to it.
      const t = await clientCredentialsToken(
        connection.id,
        { tokenUrl: auth.tokenUrl, clientId: secret.client_id, clientSecret: secret.client_secret, scopes: auth.scopes, timeoutMs: connection.timeoutMs },
        { now: Date.now },
        transportFor(connection),
      );
      if (!t.ok) return NOT_DETECTABLE;
      // No `scope` in the token response means the requested scopes were granted (RFC 6749 §5.1).
      const values = lastTokenScopes(connection.id) ?? auth.scopes;
      return { detectable: true, source: 'oauth_token_response', values: [...values] };
    }
    return NOT_DETECTABLE;
  }

  async function submitBulk(input: Parameters<WriteAdapter['submitBulk']>[0]): Promise<BulkSubmitOutcome> {
    const { connection, mapping, records, credential } = input;
    const { bulk, method, path } = mapping;
    if (bulk === undefined || method === undefined || path === undefined) return mappingFailure();
    // The mapping's own `body` template is not used: the body is built from the records below.
    const withoutBody: UpstreamMapping & { method: HttpMethod; path: string } = { ...mapping, method, path };
    delete withoutBody.body;
    let req: HttpRequestSpec;
    try {
      req = buildRequest(connection.baseUrl, withoutBody, {});
    } catch (err) {
      if (err instanceof MappingError) return mappingFailure();
      throw err;
    }
    req.body = JSON.stringify(buildBulkBody(bulk.body, records));
    req.headers['content-type'] = 'application/json';
    // Never retried by the client: a resent submit could apply the batch twice (EXE-4).
    const r = await clientOf(connection).send(req, { retryable: false, ...(credential ? { credential } : {}) });
    if (!r.ok) return classify(r, 'submit');
    const batchId = extractBatchId(r.json, bulk.batchId);
    if (batchId === undefined || !isSafeBatchId(batchId)) {
      return { ok: false, code: 'invalid_response', status: r.status, durationMs: r.durationMs, retriable: false };
    }
    return { ok: true, batchId, status: r.status, durationMs: r.durationMs };
  }

  async function bulkStatus(input: Parameters<WriteAdapter['bulkStatus']>[0]): Promise<BulkStatusOutcome> {
    const { connection, mapping, batchId, credential } = input;
    const bulk = mapping.bulk;
    // The batch ID came from the upstream: it goes into the path only when it is a plain token (SEC-5).
    if (bulk === undefined || !isSafeBatchId(batchId)) return mappingFailure();
    let req: HttpRequestSpec;
    try {
      req = buildRequest(
        connection.baseUrl,
        { pathParams: { batch_id: batchId }, query: {}, headers: {}, response: { maxItems: 1 }, method: 'GET', path: bulk.status.path },
        {},
      );
    } catch (err) {
      if (err instanceof MappingError) return mappingFailure();
      throw err;
    }
    // A status read changes nothing upstream, so the client may retry it.
    const r = await clientOf(connection).send(req, { retryable: true, ...(credential ? { credential } : {}) });
    if (!r.ok) return classify(r, 'status');
    const items = mapBulkStatus(bulk.status, r.json);
    if (items === undefined) return { ok: false, code: 'invalid_response', status: r.status, durationMs: r.durationMs, retriable: false };
    return { ok: true, items, durationMs: r.durationMs };
  }

  return { resolver, read, detectScopes, submitBulk, bulkStatus };
}

