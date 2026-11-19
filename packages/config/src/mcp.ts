/**
 * MCP-backed operations in configuration (CONN-1, CONN-4; design phase 9 §2): the
 * `upstream: { tool, pin }` variant. The pin is the `mcpToolHash` of the tool definition
 * as reviewed; the operation runs only while the live definition hashes to it.
 */
import { z } from 'zod';
import type { UpstreamConfig } from './upstream-schema.js';

/** Upstream tool names the platform binds or lists; other listed names are dropped. Same set as the design's `[A-Za-z0-9_.\/-]`. */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_./-]{1,128}$/;
/** A tool hash as `mcpToolHash` (`@aiops/connector-sdk`) returns it. */
export const PIN_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const mcpUpstreamSchema = z.strictObject({
  tool: z.string().regex(MCP_TOOL_NAME),
  pin: z.string().regex(PIN_PATTERN),
});
export type McpUpstreamConfig = z.output<typeof mcpUpstreamSchema>;

export function isMcpUpstream(u: UpstreamConfig | McpUpstreamConfig): u is McpUpstreamConfig {
  return Object.hasOwn(u, 'tool');
}
