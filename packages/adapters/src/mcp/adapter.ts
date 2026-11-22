// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * MCP tool adapter (CONN-1, CONN-3, CONN-5, CONN-6, SEC-3, SEC-5): lists and calls the tools of an
 * upstream MCP server through the official client over the guarded fetch. The era (stateless
 * 2026-07-28 or a 2025 session) is negotiated once per connection and reused; every list or call
 * is one `Client`, one semaphore slot and, for a legacy server, one session that is ended after it.
 *
 * Time bound: one attempt waits up to `timeoutMs` for a slot, then sends up to five exchanges, each
 * bounded by `timeoutMs` (the guarded fetch's per-exchange timer and the SDK request timeout):
 * the `server/discover` probe, `initialize` and `notifications/initialized` (legacy only), the
 * list or call, and the session `DELETE` (legacy only). A list or a retryable call makes up to
 * `retry.maxAttempts` attempts with backoff between them, so the worst case is about
 * `maxAttempts × 6 × timeoutMs` plus the backoff.
 */
import type { LookupFunction } from 'node:net';
import {
  CONNECTOR_SDK_VERSION,
  mcpToolHash,
  type CallOutcome,
  type ConnectionSettings,
  type CredentialSource,
  type McpListedTool,
  type McpToolAdapter,
  type McpToolDefinition,
  type ReadErrorCode,
  type ReadOutcome,
  type RequestInstrumentation,
  type ToolListOutcome,
  type WriteAdapter,
} from '@mandate/connector-sdk';
import { Client, ProtocolError, SdkError, SdkErrorCode, SdkHttpError, StreamableHTTPClientTransport, type PriorDiscovery, type Tool } from '@modelcontextprotocol/client';
import { prepareAuth } from '../http/auth.js';
import { createTransport, RETRYABLE_STATUS } from '../http/client.js';
import { createGuardedLookup } from '../http/egress.js';
import { createGuardedFetch, GuardedFetchError, type GuardedFetch } from '../http/guarded-fetch.js';
import { pacerFor } from '../http/pacer.js';
import { semaphoreFor } from '../http/semaphore.js';
import { outcomeAfterSend, outcomeOfResult } from './call-once.js';
import { mapToolResult } from './result.js';

export interface McpAdapterDeps {
  /** Hook around each upstream exchange (NFR-11). */
  readonly instrumentation?: RequestInstrumentation;
  readonly lookup?: LookupFunction;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/** Upstream tool names the adapter hands on; others are dropped and counted. Same as `MCP_TOOL_NAME` of the configuration. */
const MCP_TOOL_NAME = /^[A-Za-z0-9_./-]{1,128}$/;
const MAX_TOOLS = 1000;
/** Pages the client walks for one list. */
const LIST_MAX_PAGES = 10;
/** A cached era verdict is re-negotiated after this long. */
const ERA_TTL_MS = 10 * 60 * 1000;
/** A definition nested deeper than this is not hashed (canonical JSON recurses). */
const MAX_DEFINITION_DEPTH = 256;

interface Failure {
  ok: false;
  code: ReadErrorCode;
  status?: number;
  durationMs: number;
  message: string;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function deeperThan(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [node, depth] = next;
    if (typeof node !== 'object' || node === null) continue;
    if (depth > max) return true;
    for (const child of Object.values(node)) stack.push([child, depth + 1]);
  }
  return false;
}

/** The hashed fields of an SDK-parsed tool (ruling F14); `_meta`, `icons`, `execution` and the rest are left out. */
function definitionOf(tool: Tool): McpToolDefinition {
  return {
    name: tool.name,
    inputSchema: tool.inputSchema,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
  };
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/**
 * The outcome code of an error thrown by the client (ruling F8), or undefined for an error this
 * adapter does not recognise (a bug, which the caller rethrows). A guarded failure counts only
 * when the error comes from the transport: a `GuardedFetchError` in its cause chain, or an
 * `SdkHttpError` for the status the guarded fetch recorded last. Era negotiation produces expected
 * non-2xx exchanges, so `lastFailure()` alone is never trusted. A request timeout is `timeout`, a
 * list the SDK cannot parse is `invalid_response`; every other SDK error, a JSON-RPC error
 * (`ProtocolError`) and an abort are `upstream_error`.
 */
function classify(error: unknown, guarded: GuardedFetch, kind: 'list' | 'call'): { code: ReadErrorCode; status?: number } | undefined {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth += 1) {
    if (e instanceof GuardedFetchError) return { code: e.code };
  }
  if (SdkHttpError.isInstance(error)) {
    const last = guarded.lastFailure();
    if (last?.code === 'http_status' && last.status === error.status) return { code: 'http_status', status: error.status };
  }
  if (SdkError.isInstance(error)) {
    if (error.code === SdkErrorCode.RequestTimeout) return { code: 'timeout' };
    if (kind === 'list' && (error.code === SdkErrorCode.InvalidResult || error.code === SdkErrorCode.ListPaginationExceeded)) {
      return { code: 'invalid_response' };
    }
    return { code: 'upstream_error' };
  }
  if (ProtocolError.isInstance(error) || isAbort(error)) return { code: 'upstream_error' };
  return undefined;
}

function isRetryable(f: { ok: boolean; code?: ReadErrorCode; status?: number }): boolean {
  if (f.code === 'timeout' || f.code === 'network') return true;
  return f.code === 'http_status' && f.status !== undefined && RETRYABLE_STATUS.has(f.status);
}

interface EraEntry {
  prior: PriorDiscovery;
  at: number;
}

/** The MCP adapter: the SDK's tool adapter plus the opaque call path (ruling F5). */
export type McpAdapter = McpToolAdapter & Required<Pick<WriteAdapter, 'callOnce'>>;

/** An opaque call's settled exchange, told apart from a `Failure` by `outcome`. */
interface CallSettled {
  ok: boolean;
  outcome: CallOutcome;
}

export function createMcpToolAdapter(deps: McpAdapterDeps = {}): McpAdapter {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const eras = new Map<string, EraEntry>();
  const eraKey = (s: ConnectionSettings): string => `${s.id}\0${s.baseUrl}`;

  const priorOf = (s: ConnectionSettings): PriorDiscovery | undefined => {
    const key = eraKey(s);
    const entry = eras.get(key);
    if (entry === undefined) return undefined;
    if (now() - entry.at >= ERA_TTL_MS) {
      eras.delete(key);
      return undefined;
    }
    return entry.prior;
  };

  /**
   * One client operation: a slot, the credential, a guarded fetch, a client connected in the
   * cached era (or negotiating it), `work`, then the session ended and the client closed.
   */
  async function attempt<T extends { ok: boolean }>(
    connection: ConnectionSettings,
    credential: CredentialSource | undefined,
    kind: 'list' | 'call',
    start: number,
    work: (client: Client, guarded: GuardedFetch) => Promise<T | Failure>,
  ): Promise<T | Failure> {
    const fail = (code: ReadErrorCode, status?: number): Failure => ({
      ok: false,
      code,
      ...(status === undefined ? {} : { status }),
      durationMs: Math.max(0, now() - start),
      message: `upstream tool ${kind} failed (${code})`,
    });

    // The loader refuses oauth1 on an mcp connection; if it ever got here, nothing is sent (CONN-3).
    if (connection.auth?.scheme === 'oauth1') return fail('credential_unusable');
    const release = await semaphoreFor(connection.id, connection.maxConcurrency).acquire(connection.timeoutMs);
    if (!release) return fail('busy');
    try {
      // Pacing (CONN-6), as in the HTTP client: one slot per operation; too far away is `busy`.
      const paceWait = pacerFor(connection.id, connection.minIntervalMs).reserve(now(), connection.timeoutMs);
      if (paceWait === undefined) return fail('busy');
      if (paceWait > 0) await sleep(paceWait);
      const lookup = deps.lookup ?? createGuardedLookup(connection);
      const prepared = await prepareAuth(connection, credential, { now, transport: createTransport(connection, lookup) });
      if (!prepared.ok) return fail(prepared.code, prepared.status);
      const guarded = createGuardedFetch(connection, prepared.auth, {
        lookup,
        ...(deps.instrumentation === undefined ? {} : { instrumentation: deps.instrumentation }),
      });
      let url: URL;
      try {
        url = new URL(connection.baseUrl);
      } catch {
        return fail('egress_denied');
      }
      const transport = new StreamableHTTPClientTransport(url, { fetch: guarded.fetch, onInsufficientScope: 'throw' });
      const client = new Client(
        { name: 'mandate-upstream', version: CONNECTOR_SDK_VERSION },
        { capabilities: {}, versionNegotiation: { mode: 'auto' }, inputRequired: { autoFulfill: false }, listMaxPages: LIST_MAX_PAGES },
      );
      const prior = priorOf(connection);
      try {
        await client.connect(transport, prior === undefined ? { timeout: connection.timeoutMs } : { prior, timeout: connection.timeoutMs });
        const result = await work(client, guarded);
        if (!result.ok) {
          eras.delete(eraKey(connection));
        } else if (prior === undefined) {
          // A newly negotiated verdict; a reused one keeps its age, so it expires ERA_TTL_MS after negotiation.
          const discover = client.getDiscoverResult();
          if (discover !== undefined) eras.set(eraKey(connection), { prior: { kind: 'modern', discover }, at: now() });
          else if (client.getProtocolEra() === 'legacy') eras.set(eraKey(connection), { prior: { kind: 'legacy' }, at: now() });
        }
        return result;
      } catch (error) {
        eras.delete(eraKey(connection));
        const c = classify(error, guarded, kind);
        // Not an upstream failure: a bug here must not look like a misbehaving upstream. The
        // finally blocks still end the session and release the slot.
        if (c === undefined) throw error;
        return fail(c.code, c.status);
      } finally {
        // F2: the client's close() only aborts; a legacy session is ended with DELETE first.
        if (transport.sessionId !== undefined) {
          try {
            await transport.terminateSession();
          } catch {
            // The session is the server's to expire; the outcome is already decided.
          }
        }
        try {
          await client.close();
        } catch {
          // Closing never changes the outcome.
        }
      }
    } finally {
      release();
    }
  }

  /** Retries per R5 around whole operations, for lists and retryable calls only. */
  async function withRetries<T extends { ok: boolean }>(connection: ConnectionSettings, retryable: boolean, run: () => Promise<T | Failure>): Promise<T | Failure> {
    const maxAttempts = retryable ? Math.max(1, connection.retry.maxAttempts) : 1;
    for (let retries = 0; ; retries += 1) {
      const result = await run();
      if (result.ok || !isRetryable(result) || retries + 1 >= maxAttempts) return result;
      await sleep(connection.retry.initialBackoffMs * 2 ** retries * random());
    }
  }

  async function listTools({ connection, credential }: Parameters<McpToolAdapter['listTools']>[0]): Promise<ToolListOutcome> {
    const start = now();
    const invalid = (): Failure => ({ ok: false, code: 'invalid_response', durationMs: Math.max(0, now() - start), message: 'upstream tool list failed (invalid_response)' });
    return withRetries(connection, true, () =>
      attempt<ToolListOutcome>(connection, credential, 'list', start, async (client) => {
        const { tools } = await client.listTools(undefined, { timeout: connection.timeoutMs });
        if (tools.length > MAX_TOOLS) return invalid();
        const names = new Set<string>();
        const listed: McpListedTool[] = [];
        let dropped = 0;
        for (const tool of tools) {
          if (names.has(tool.name)) return invalid();
          names.add(tool.name);
          if (!MCP_TOOL_NAME.test(tool.name)) {
            dropped += 1;
            continue;
          }
          const definition = definitionOf(tool);
          if (deeperThan(definition, MAX_DEFINITION_DEPTH)) return invalid();
          let hash: string;
          try {
            hash = mcpToolHash(definition);
          } catch (error) {
            // canonicalJson refuses values JSON cannot carry: the list is not a valid answer.
            if (error instanceof TypeError) return invalid();
            throw error;
          }
          listed.push({ definition, hash });
        }
        return { ok: true, tools: listed, dropped, durationMs: Math.max(0, now() - start) };
      }),
    );
  }

  async function callTool(input: Parameters<McpToolAdapter['callTool']>[0]): Promise<ReadOutcome> {
    const { connection, tool, args, credential, retryable } = input;
    const start = now();
    return withRetries(connection, retryable, () =>
      attempt<ReadOutcome>(connection, credential, 'call', start, async (client, guarded) => {
        const result = await client.callTool({ name: tool, arguments: { ...args } }, { timeout: connection.timeoutMs });
        return mapToolResult(result, guarded.scrubber, Math.max(0, now() - start));
      }),
    );
  }

  /**
   * One opaque `tools/call` (EXE-4, NFR-2, ruling F7): connect (era negotiation; a legacy
   * `initialize` is not the call), `beforeSend`, one `tools/call` without retry, then the session
   * ended. A failure before the hook ran answers `not_sent` with its code; a throwing hook is
   * rethrown with nothing sent. Once the hook ran nothing is resent: no attempt loop, no 401
   * refresh, and the SDK's header-mismatch re-call is off because a tool definition is passed.
   * No idempotency key is sent; the result's content is never read.
   */
  async function callOnce(input: Parameters<NonNullable<WriteAdapter['callOnce']>>[0]): Promise<CallOutcome> {
    const { connection, target, credential, beforeSend } = input;
    if (target.kind !== 'mcp' || !MCP_TOOL_NAME.test(target.tool)) return { result: 'not_sent', code: 'mapping', durationMs: 0 };
    const name = target.tool;
    // Copied before the hook: a failing argument read records nothing.
    const args = { ...input.args };
    const start = now();
    const elapsed = (): number => Math.max(0, now() - start);
    let hookError: { error: unknown } | undefined;
    const settled = await attempt<CallSettled>(connection, credential, 'call', start, async (client, guarded) => {
      try {
        await beforeSend();
      } catch (error) {
        hookError = { error };
        throw error;
      }
      // Sent from here on: a guarded 401 is answered, never refreshed and resent.
      guarded.noResend();
      try {
        // A definition without outputSchema or header declarations: the SDK neither validates the
        // result (which is never read) nor re-calls the tool after a header mismatch.
        const result = await client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs, toolDefinition: { name, inputSchema: { type: 'object' } } });
        const outcome = outcomeOfResult(result, elapsed());
        return { ok: outcome.result === 'accepted', outcome };
      } catch (error) {
        return { ok: false, outcome: outcomeAfterSend(error, elapsed()) };
      }
    });
    // A hook error the transport classifier happens to recognise is still the caller's error.
    if (hookError !== undefined) throw hookError.error;
    if ('outcome' in settled) return settled.outcome;
    return { result: 'not_sent', code: settled.code, ...(settled.status === undefined ? {} : { status: settled.status }), durationMs: settled.durationMs };
  }

  return { listTools, callTool, callOnce };
}
