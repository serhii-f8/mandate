// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { HttpMethod } from './mapping.js';
import type { ReadErrorCode } from './read.js';
import type { RecordSendOutcome } from './write.js';

/** since 0.6.0, additive. A query value a code operation may send. */
export type CodeQueryValue = string | number | boolean | readonly (string | number | boolean)[];

/** since 0.6.0, additive. One request of a code operation through `ctx.http`. */
export interface CodeHttpRequest {
  readonly method: HttpMethod;
  /** Relative to the connection's base URL; starts with `/`; segments already percent-encoded. */
  readonly path: string;
  readonly query?: Readonly<Record<string, CodeQueryValue>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** since 0.6.0, additive. The answer of `ctx.http.send`: the parsed JSON body, or a fixed code. */
export type CodeHttpResponse =
  | { readonly ok: true; readonly status: number; readonly json: unknown }
  | { readonly ok: false; readonly code: ReadErrorCode; readonly status?: number };

/** since 0.6.0, additive. HTTP client bound to the connection (base URL, credential, egress guard). */
export interface CodeHttpClient {
  send(request: CodeHttpRequest): Promise<CodeHttpResponse>;
}

/** since 0.6.0, additive. What a code operation receives besides its arguments. */
export interface CodeContext {
  readonly http: CodeHttpClient;
  readonly signal: AbortSignal;
  readonly connection: { readonly id: string };
}

/** since 0.6.0, additive. The validated arguments of the call or change-set. */
export type CodeArgs = Readonly<Record<string, unknown>>;
/** since 0.6.0, additive. One record read from or written to the upstream. */
export type WriteRecord = Readonly<Record<string, unknown>>;

/** since 0.6.0, additive. */
export interface CodeReadResult {
  readonly items: readonly WriteRecord[];
  readonly total?: number;
}

/** since 0.6.0, additive. The outcome of one record of a code write, in record order. */
export type RecordOutcome = 'ok' | 'failed' | 'retriable';

/**
 * since 0.6.0, additive. The outcome of one per-record request (OPS-6): a 2xx, or a 2xx the client
 * could not read (`invalid_response`), is `ok` and the verify read decides; a failure the adapter
 * marks retriable (429, 5xx, timeout, network, busy) is `retriable`; every other failure is `failed`.
 */
export function recordOutcomeOf(outcome: RecordSendOutcome): RecordOutcome {
  if (outcome.ok || outcome.code === 'invalid_response') return 'ok';
  return outcome.retriable ? 'retriable' : 'failed';
}

/**
 * since 0.6.0, additive. The outcome of a code call. `definite: true` means the upstream
 * refused and nothing was applied. Named apart from the opaque `CallOutcome` of write.ts.
 */
export type CodeCallOutcome = { readonly ok: true } | { readonly ok: false; readonly definite: boolean };

/** since 0.6.0, additive. */
export interface CodeReadOperation {
  readonly kind: 'read';
  read(ctx: CodeContext, args: CodeArgs): Promise<CodeReadResult>;
}

/**
 * since 0.6.0, additive. Why a code write runs: `forward` executes the change-set, `rollback`
 * puts back the values the change-set replaced (EXE-8).
 */
export type CodeWriteDirection = 'forward' | 'rollback';

/** since 0.6.0, additive. The context of a code write: the code context plus its direction. */
export interface CodeWriteContext extends CodeContext {
  readonly direction: CodeWriteDirection;
}

/**
 * since 0.6.0, additive. Writes `records` and answers one outcome per record, in record order.
 *
 * - `records` carry the values to write, in both directions: going forward, the new values;
 *   in a rollback (`ctx.direction === 'rollback'`), the values read before execution, to restore.
 *   Build every request from the records.
 * - `args` are the change-set's original validated arguments, also in a rollback: they describe
 *   the forward change (for example the new values in `changes`), so a request built from them in
 *   a rollback re-applies the change instead of undoing it. Use them for context such as a scope
 *   or a parent identifier only.
 * - The write may be invoked again for records it already applied: after a sibling answered
 *   `retriable`, after a throw or after the deadline, the batch is retried and the records not yet
 *   confirmed are sent again. Each record write must therefore be idempotent (a PUT of the full
 *   value, not an append or a toggle).
 */
export interface CodeWriteOperation {
  readonly kind: 'write';
  write(ctx: CodeWriteContext, records: readonly WriteRecord[], args: CodeArgs): Promise<readonly RecordOutcome[]>;
}

/** since 0.6.0, additive. */
export interface CodeCallOperation {
  readonly kind: 'call';
  call(ctx: CodeContext, args: CodeArgs): Promise<CodeCallOutcome>;
}

/** since 0.6.0, additive. */
export type CodeOperation = CodeReadOperation | CodeWriteOperation | CodeCallOperation;

/**
 * since 0.6.0, additive. The default export of a preset's code module. Presets write
 * `export default { operations: { … } } satisfies PresetModule`.
 */
export interface PresetModule {
  readonly operations: Readonly<Record<string, CodeOperation>>;
}

const OPERATION_NAME = /^[a-z][a-z0-9_]{0,62}$/;
/** A name short and printable enough to be named in a message. */
const SHOWABLE_NAME = /^[\x21-\x7e]{1,64}$/;
const KINDS = ['read', 'write', 'call'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * since 0.6.0, additive. Structural check of a code module's default export; the message names
 * a key, never a value. The returned `operations` has no prototype, so a name like
 * `constructor` never resolves to an inherited member.
 */
export function parsePresetModule(value: unknown): { ok: true; module: PresetModule } | { ok: false; message: string } {
  if (!isRecord(value) || !isRecord(value.operations)) return { ok: false, message: 'operations must be an object' };
  const source = value.operations;
  const operations: Record<string, CodeOperation> = Object.create(null) as Record<string, CodeOperation>;
  for (const name of Object.keys(source)) {
    if (!OPERATION_NAME.test(name)) {
      const shown = SHOWABLE_NAME.test(name) ? name : '(value)';
      return { ok: false, message: `operation name ${shown} is invalid` };
    }
    const op = source[name];
    const kind = isRecord(op) ? op.kind : undefined;
    const known = KINDS.find((k) => k === kind);
    if (!isRecord(op) || known === undefined) return { ok: false, message: `operation ${name}: unknown kind` };
    if (typeof op[known] !== 'function') {
      return { ok: false, message: `operation ${name}: kind ${known} needs a ${known} function` };
    }
    // The kind and its function were checked above; the signature is the module's contract.
    operations[name] = op as unknown as CodeOperation;
  }
  return { ok: true, module: { operations: Object.freeze(operations) } };
}
