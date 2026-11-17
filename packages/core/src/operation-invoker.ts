import type { Caller } from './caller.js';
import type { TaskRecord } from './task.js';
import type { OperationDefinition } from './policy-model.js';

/** What running an operation produced, independent of the MCP wire format. */
export interface InvocationResult {
  readonly text: string;
  readonly structured?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  /** Second text block: the data as JSON, for clients that ignore structuredContent. */
  readonly dataText?: string;
  /** Merged into the `tool.call` audit row. Non-sensitive only (SEC-3). */
  readonly auditDetails?: Readonly<Record<string, string | number | boolean>>;
  /** A task created for this call; set only when the request declared tasks (MCP-7). */
  readonly task?: TaskRecord;
}

export interface InvocationRequest {
  readonly operation: OperationDefinition;
  /** Arguments already validated against the operation's input schema (MCP-3). */
  readonly args: Readonly<Record<string, unknown>>;
  /** The verified caller. Never carries the access token (AUTH-7). */
  readonly caller: Caller;
  /** The request declared Tasks; an invoker that supports tasks may answer with `task` (MCP-7). */
  readonly asTask?: boolean;
  /**
   * Adds non-sensitive details to the call's `tool.call` audit row as soon as they are known, so
   * they survive a later throw (a failed task write keeps the change-set ID). Merged with, and
   * overridden by, `auditDetails` of the result. Non-sensitive only (SEC-3).
   */
  readonly report?: (details: Readonly<Record<string, string | number | boolean>>) => void;
}

/**
 * Runs an allowed operation. Called only after an allow decision from the same
 * request (SEC-1). Phase 3 implements the direct execution path behind it.
 */
export interface OperationInvoker {
  invoke(request: InvocationRequest): Promise<InvocationResult>;
}
