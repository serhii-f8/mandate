import type { ArgumentCheck } from '@aiops/config';
import type { Caller } from '@aiops/core';
import type { AuditDetails } from './audited-tool.js';
import type { ToolAnswer } from './tasks/task-result.js';
import type { Snapshot } from './tool-pipeline.js';

/** What a built-in handler receives besides its arguments (design 6.2). */
export interface BuiltinContext {
  readonly caller: Caller;
  readonly snapshot: Snapshot;
  readonly correlationId: string;
  /** The request declared the Tasks extension; only then may the handler answer with a task (MCP-7). */
  readonly tasks: boolean;
  /** Adds non-sensitive details to the `tool.call` audit row (AUD-1, SEC-3). */
  readonly report: (details: AuditDetails) => void;
}

/**
 * A platform tool that is not an operation (`ping`, later the MCP-8 tools).
 * Available to every authenticated caller; still validated, decided (rule
 * `builtin`) and audited like an operation.
 */
export interface BuiltinTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema published in `tools/list`. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Announced in `tools/list`; a built-in that changes state declares false. Default true. */
  readonly readOnlyHint?: boolean;
  validate(args: unknown): ArgumentCheck;
  /** Receives arguments that passed `validate`. */
  handler(args: Readonly<Record<string, unknown>>, ctx: BuiltinContext): Promise<ToolAnswer>;
}
