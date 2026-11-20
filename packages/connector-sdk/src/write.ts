import type { ConnectionSettings } from './connection.js';
import type { CredentialSource } from './credentials.js';
import type { CodeArgs, CodeCallOperation, CodeReadOperation, CodeWriteDirection, CodeWriteOperation, RecordOutcome, WriteRecord } from './code.js';
import type { ResponseMapping, UpstreamMapping } from './mapping.js';
import type { ReadErrorCode, ReadOutcome } from './read.js';

export type WriteErrorCode = ReadErrorCode | 'rejected';
export type BulkItemState = 'ok' | 'failed' | 'retriable' | 'open';

export interface WriteFailure {
  ok: false;
  code: WriteErrorCode;
  status?: number;
  durationMs: number;
  retriable: boolean;
}

export type BulkSubmitOutcome = { ok: true; batchId: string; status: number; durationMs: number } | WriteFailure;
export type BulkStatusOutcome =
  | { ok: true; items: readonly { index: number; state: BulkItemState }[]; durationMs: number }
  | WriteFailure;

/**
 * since 0.6.0, additive. What one opaque call addresses: an HTTP mapping of an OpenAPI
 * connection or a tool of an MCP connection.
 */
export type CallTarget = { readonly kind: 'http'; readonly mapping: UpstreamMapping } | { readonly kind: 'mcp'; readonly tool: string };

/** since 0.6.0, additive. The outcome of one call sent at most once (EXE-4); codes only (SEC-3). */
export interface CallOutcome {
  /**
   * `accepted`: the upstream answered success. `refused`: it answered a definite refusal.
   * `unknown`: the request may have been applied (timeout, network error, 3xx, 5xx).
   * `not_sent`: no request reached the upstream. Usually `beforeSend` was not called; only a
   * refusal at connect (egress guard on the resolved address) comes after it.
   */
  readonly result: 'accepted' | 'refused' | 'unknown' | 'not_sent';
  /** For `refused`, `unknown`, `not_sent`: a fixed code, never upstream text. */
  readonly code?: WriteErrorCode;
  readonly status?: number;
  readonly durationMs: number;
}

export interface WriteAdapter {
  submitBulk(input: {
    connection: ConnectionSettings;
    mapping: UpstreamMapping;
    records: readonly Readonly<Record<string, unknown>>[];
    credential?: CredentialSource;
  }): Promise<BulkSubmitOutcome>;
  bulkStatus(input: {
    connection: ConnectionSettings;
    mapping: UpstreamMapping;
    batchId: string;
    credential?: CredentialSource;
    /** since 0.6.0, additive. The target IDs in plan order, for `bulk.status.key`. */
    keys?: readonly string[];
  }): Promise<BulkStatusOutcome>;
  /**
   * since 0.6.0, additive. Sends one call at most once, never retried (EXE-4, NFR-2). Every
   * check that can refuse without sending (mapping, credential, egress, a free slot) runs first
   * and answers `not_sent` without calling `beforeSend`; then `beforeSend` runs immediately
   * before the request leaves. If it throws, nothing is sent and the error is rethrown. The
   * response body is discarded unread: the outcome depends on the status only.
   */
  callOnce(input: {
    connection: ConnectionSettings;
    target: CallTarget;
    args: Readonly<Record<string, unknown>>;
    credential?: CredentialSource;
    /** Sent as `mapping.idempotency.header` when the HTTP mapping declares one; ignored for MCP. */
    idempotencyKey?: string;
    beforeSend: () => Promise<void>;
  }): Promise<CallOutcome>;
}

/** since 0.6.0, additive. The outcome of one per-record request. */
export type RecordSendOutcome = { ok: true; status: number; durationMs: number } | WriteFailure;

/** since 0.6.0. Sends one record of a per-record write binding (OPS-6). */
export interface RecordWriteAdapter {
  writeRecord(input: {
    connection: ConnectionSettings;
    mapping: UpstreamMapping;
    record: WriteRecord;
    args: CodeArgs;
    credential?: CredentialSource;
  }): Promise<RecordSendOutcome>;
}

/** since 0.6.0, additive. One outcome per record, in record order. */
export type CodeWriteOutcome = { ok: true; outcomes: readonly RecordOutcome[]; durationMs: number } | WriteFailure;
/** since 0.6.0, additive. Codes only (SEC-3). */
export type CodeCallResult =
  | { ok: true; durationMs: number }
  | { ok: false; definite: boolean; code: WriteErrorCode; durationMs: number };

/** since 0.6.0. Runs a preset's code operations (OPS-5). */
export interface CodeAdapter {
  codeRead(input: {
    connection: ConnectionSettings;
    name: string;
    operation: CodeReadOperation;
    args: CodeArgs;
    response: ResponseMapping;
    credential?: CredentialSource;
    exactValues?: boolean;
  }): Promise<ReadOutcome>;
  codeWrite(input: {
    connection: ConnectionSettings;
    name: string;
    operation: CodeWriteOperation;
    records: readonly WriteRecord[];
    args: CodeArgs;
    /** since 0.6.0, additive. Handed to the code as `ctx.direction`; absent means `forward`. */
    direction?: CodeWriteDirection;
    credential?: CredentialSource;
    onProgress?: () => void;
  }): Promise<CodeWriteOutcome>;
  codeCall(input: {
    connection: ConnectionSettings;
    name: string;
    operation: CodeCallOperation;
    args: CodeArgs;
    credential?: CredentialSource;
  }): Promise<CodeCallResult>;
}
