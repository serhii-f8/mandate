import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ArgumentCheck } from '@aiops/config';
import type { Caller } from '@aiops/core';

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
  validate(args: unknown): ArgumentCheck;
  /** Receives arguments that passed `validate`. */
  handler(args: Readonly<Record<string, unknown>>, caller: Caller): Promise<CallToolResult>;
}
