/**
 * Runs a preset's code operations (OPS-5): each invocation gets a fresh `ctx` with the guarded
 * HTTP client of its connection, an abort signal and a deadline. The code's result is copied as
 * JSON and checked before it is used; a throw, a malformed result or the deadline become fixed
 * codes. The thrown text reaches only the optional `onCodeError` hook, scrubbed and cut (SEC-3).
 */
import type {
  CodeAdapter,
  CodeCallResult,
  CodeContext,
  CodeWriteContext,
  CodeWriteOutcome,
  ConnectionSettings,
  CredentialSource,
  ReadOutcome,
  RecordOutcome,
} from '@aiops/connector-sdk';
import type { ConnectionClient } from '../http/client.js';
import { createScrubber } from '../http/scrub.js';
import { MappingError } from '../openapi/request.js';
import { mapResponse } from '../openapi/response.js';
import { createCodeHttpClient } from './http.js';

/** Upper bound of `ctx.http.send` calls per invocation; calls beyond it answer `busy`. */
export const MAX_CODE_REQUESTS = 1000;
const DEFAULT_READ_MS = 60_000;
const DEFAULT_WRITE_MS = 300_000;
const MAX_ERROR_MESSAGE = 500;

export interface CodeRunnerDeps {
  readonly clientOf: (s: ConnectionSettings) => ConnectionClient;
  readonly onCodeError?: (event: { connection: string; operation: string; kind: 'read' | 'write' | 'call'; message: string }) => void;
  readonly codeDeadlines?: { readonly readMs: number; readonly writeMs: number };
}

type Kind = 'read' | 'write' | 'call';
/** How an invocation ended, before it is mapped to the kind's outcome. */
type Run = { end: 'done'; value: unknown } | { end: 'invalid' } | { end: 'threw' } | { end: 'timeout'; ms: number } | { end: 'mcp' };

const OUTCOMES: ReadonlySet<unknown> = new Set<RecordOutcome>(['ok', 'failed', 'retriable']);
const isOutcome = (o: unknown): o is RecordOutcome => OUTCOMES.has(o);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isNonNegativeInteger = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * A plain-data copy of the code's result: getters, prototypes and functions do not survive.
 * Undefined when it cannot be serialised (a cycle, a BigInt, a throwing getter).
 */
function jsonCopy(value: unknown): { value: unknown } | undefined {
  try {
    // JSON.stringify answers undefined for undefined, a function or symbol; its declared type omits that.
    const text = JSON.stringify(value) as string | undefined;
    return text === undefined ? undefined : { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/** The thrown value's message; reading it may itself throw. */
function messageOf(err: unknown): string {
  try {
    const message: unknown = err instanceof Error ? err.message : err;
    return typeof message === 'string' ? message : 'error without a message';
  } catch {
    return 'unreadable error';
  }
}

/** The context of a read or a call: nothing beyond the base. */
const plain = (base: CodeContext): CodeContext => base;

export function createCodeRunner(deps: CodeRunnerDeps): CodeAdapter {
  const readMs = deps.codeDeadlines?.readMs ?? DEFAULT_READ_MS;
  const writeMs = deps.codeDeadlines?.writeMs ?? DEFAULT_WRITE_MS;

  /** Scrubs the opened credential's values from the thrown text, replaces controls and cuts it. */
  async function reportError(connection: ConnectionSettings, operation: string, kind: Kind, credential: CredentialSource | undefined, err: unknown): Promise<void> {
    const hook = deps.onCodeError;
    if (hook === undefined) return;
    let secrets: string[] = [];
    if (credential !== undefined) {
      try {
        secrets = Object.values(await credential.open()).filter((v): v is string => typeof v === 'string');
      } catch {
        // Nothing opened, nothing to scrub; the text still goes through the cut below.
        secrets = [];
      }
    }
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is replaced
    const message = createScrubber(secrets).text(messageOf(err)).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, MAX_ERROR_MESSAGE);
    try {
      hook({ connection: connection.id, operation, kind, message });
    } catch {
      // A failing hook never changes the outcome.
    }
  }

  /**
   * Runs `fn` with a fresh context until it settles or the deadline passes. The signal is aborted
   * at the deadline before `timeout` is answered, and in every case once the run ends, so a send
   * the code starts afterwards is refused without a request (F26).
   */
  async function invoke<C extends CodeContext>(
    kind: Kind,
    input: { connection: ConnectionSettings; name: string; credential?: CredentialSource; onProgress?: () => void },
    extend: (base: CodeContext) => C,
    fn: (ctx: C) => Promise<unknown>,
  ): Promise<Run & { durationMs: number }> {
    const start = Date.now();
    const elapsed = (): number => Math.max(0, Date.now() - start);
    const { connection, name, credential } = input;
    // An mcp connection has no HTTP base URL for the code to use (F22: the loader refuses it first).
    if (connection.kind === 'mcp') return { end: 'mcp', durationMs: 0 };
    const ms = kind === 'read' ? readMs : writeMs;
    const controller = new AbortController();
    const http = createCodeHttpClient({
      client: deps.clientOf(connection),
      connection,
      signal: controller.signal,
      maxRequests: MAX_CODE_REQUESTS,
      ...(credential === undefined ? {} : { credential }),
      ...(input.onProgress === undefined ? {} : { onSend: input.onProgress }),
    });
    const ctx: C = Object.freeze(extend({ http, signal: controller.signal, connection: Object.freeze({ id: connection.id }) }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, ms);
    });
    // A synchronous throw from the code is caught like a rejection.
    const work = (async () => fn(ctx))().then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    try {
      const settled = await Promise.race([work, deadline]);
      if (settled === 'timeout') return { end: 'timeout', ms, durationMs: elapsed() };
      if (!settled.ok) {
        await reportError(connection, name, kind, credential, settled.err);
        return { end: 'threw', durationMs: elapsed() };
      }
      const copy = jsonCopy(settled.value);
      return copy === undefined ? { end: 'invalid', durationMs: elapsed() } : { end: 'done', value: copy.value, durationMs: elapsed() };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  const codeRead: CodeAdapter['codeRead'] = async (input) => {
    const { operation, args, response, exactValues } = input;
    const run = await invoke('read', input, plain, (ctx) => operation.read(ctx, args));
    const { durationMs } = run;
    const invalid: ReadOutcome = { ok: false, code: 'invalid_response', durationMs, message: 'preset code returned an invalid result' };
    switch (run.end) {
      case 'mcp':
        return { ok: false, code: 'mapping', durationMs, message: 'code operations need an openapi connection' };
      case 'threw':
        return { ok: false, code: 'upstream_error', durationMs, message: 'preset code failed' };
      case 'timeout':
        return { ok: false, code: 'timeout', durationMs, message: `preset code did not finish within ${run.ms} ms` };
      case 'invalid':
        return invalid;
      case 'done':
        break;
    }
    const result = run.value;
    if (!isPlainObject(result) || !Array.isArray(result.items) || !result.items.every(isPlainObject)) return invalid;
    if (result.total !== undefined && !isNonNegativeInteger(result.total)) return invalid;
    try {
      const mapped = mapResponse({ ...response, items: 'items', total: 'total' }, result, args, exactValues === true ? { exactValues } : {});
      // A code read has no HTTP status of its own; 200 stands for a successful read.
      return { ok: true, status: 200, durationMs, ...mapped };
    } catch (err) {
      if (err instanceof MappingError) return { ok: false, code: 'mapping', durationMs, message: err.message };
      throw err;
    }
  };

  const codeWrite: CodeAdapter['codeWrite'] = async (input): Promise<CodeWriteOutcome> => {
    const { operation, records, args } = input;
    const direction = input.direction ?? 'forward';
    const withDirection = (base: CodeContext): CodeWriteContext => ({ ...base, direction });
    const run = await invoke('write', input, withDirection, (ctx) => operation.write(ctx, records, args));
    const { durationMs } = run;
    switch (run.end) {
      case 'mcp':
        return { ok: false, code: 'mapping', durationMs, retriable: false };
      case 'threw':
        return { ok: false, code: 'upstream_error', durationMs, retriable: true };
      case 'timeout':
        return { ok: false, code: 'timeout', durationMs, retriable: true };
      case 'invalid':
        return { ok: false, code: 'invalid_response', durationMs, retriable: false };
      case 'done':
        break;
    }
    const outcomes = run.value;
    if (!Array.isArray(outcomes) || outcomes.length !== records.length || !outcomes.every(isOutcome)) {
      return { ok: false, code: 'invalid_response', durationMs, retriable: false };
    }
    return { ok: true, outcomes, durationMs };
  };

  const codeCall: CodeAdapter['codeCall'] = async (input): Promise<CodeCallResult> => {
    const { operation, args } = input;
    const run = await invoke('call', input, plain, (ctx) => operation.call(ctx, args));
    const { durationMs } = run;
    switch (run.end) {
      case 'mcp':
        // Nothing was sent, so nothing can have been applied.
        return { ok: false, definite: true, code: 'mapping', durationMs };
      case 'threw':
        return { ok: false, definite: false, code: 'upstream_error', durationMs };
      case 'timeout':
        return { ok: false, definite: false, code: 'timeout', durationMs };
      case 'invalid':
        return { ok: false, definite: false, code: 'invalid_response', durationMs };
      case 'done':
        break;
    }
    const result = run.value;
    if (isPlainObject(result) && result.ok === true) return { ok: true, durationMs };
    if (isPlainObject(result) && result.ok === false && typeof result.definite === 'boolean') {
      return result.definite
        ? { ok: false, definite: true, code: 'rejected', durationMs }
        : { ok: false, definite: false, code: 'upstream_error', durationMs };
    }
    return { ok: false, definite: false, code: 'invalid_response', durationMs };
  };

  return { codeRead, codeWrite, codeCall };
}
