import type { CallToolResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { Caller } from '@aiops/core';

/** One tool as the MCP endpoint registers it. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  /** Receives arguments already validated against `inputSchema` by the SDK. */
  handler(args: unknown, caller: Caller): Promise<CallToolResult>;
}

/**
 * Which tools a caller sees and may call. The per-request server factory asks it
 * for every request, so the list is per caller (MCP-2); Phase 2 backs it with
 * the policy engine and role grants.
 */
export interface ToolCatalog {
  toolsFor(caller: Caller): readonly ToolDefinition[];
}

export const TOOL_CATALOG = Symbol('ToolCatalog');

export class StaticToolCatalog implements ToolCatalog {
  constructor(private readonly tools: readonly ToolDefinition[]) {}

  toolsFor(): readonly ToolDefinition[] {
    return this.tools;
  }
}
