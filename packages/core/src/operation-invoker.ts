import type { Caller } from './caller.js';
import type { OperationDefinition } from './policy-model.js';

/** What running an operation produced, independent of the MCP wire format. */
export interface InvocationResult {
  readonly text: string;
  readonly structured?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

export interface InvocationRequest {
  readonly operation: OperationDefinition;
  /** Arguments already validated against the operation's input schema (MCP-3). */
  readonly args: Readonly<Record<string, unknown>>;
  /** The verified caller. Never carries the access token (AUTH-7). */
  readonly caller: Caller;
}

/**
 * Runs an allowed operation. Called only after an allow decision from the same
 * request (SEC-1). Phase 3 implements the direct execution path behind it.
 */
export interface OperationInvoker {
  invoke(request: InvocationRequest): Promise<InvocationResult>;
}
