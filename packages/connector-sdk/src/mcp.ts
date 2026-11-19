import { createHash } from 'node:crypto';
import type { ConnectionSettings } from './connection.js';
import type { CredentialSource } from './credentials.js';
import type { ReadErrorCode, ReadOutcome } from './read.js';

/**
 * One tool as an upstream MCP server lists it (since 0.6.0). Adapters fill it from the
 * definition the MCP SDK has already parsed and normalised (for example unknown annotation
 * keys stripped), so the hash below is computed over the SDK-parsed definition, not over the
 * raw bytes the server sent.
 */
export interface McpToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
}

/** A listed tool and its hash, the value operators pin (CONN-4; since 0.6.0). */
export interface McpListedTool {
  readonly definition: McpToolDefinition;
  readonly hash: string;
}

/** The result of listing an MCP connection's tools (since 0.6.0). `dropped` counts tools with invalid names. */
export type ToolListOutcome =
  | { ok: true; tools: readonly McpListedTool[]; dropped: number; durationMs: number }
  | { ok: false; code: ReadErrorCode; status?: number; durationMs: number; message: string };

/** Lists and calls tools of an MCP upstream (CONN-1; since 0.6.0). */
export interface McpToolAdapter {
  listTools(input: { connection: ConnectionSettings; credential?: CredentialSource }): Promise<ToolListOutcome>;
  callTool(input: {
    connection: ConnectionSettings;
    tool: string;
    args: Readonly<Record<string, unknown>>;
    credential?: CredentialSource;
    /** True for reads: the call may be retried on transient failures. */
    retryable: boolean;
  }): Promise<ReadOutcome>;
}

/**
 * Deterministic JSON: sorted keys (UTF-16 code unit order), no whitespace. Byte-identical to
 * `canonicalJson` of `@aiops/core`, which the SDK may not import. Non-finite numbers, sparse
 * arrays, non-plain objects and other unsupported values throw a `TypeError`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) throw new TypeError('canonicalJson: sparse array');
          parts.push(canonicalJson(value[i]));
        }
        return `[${parts.join(',')}]`;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: non-plain object');
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
  }
}

const TOOL_HASH_FORMAT = 'aiops.mcp-tool.v1';

/**
 * The pin of a tool (CONN-4): `sha256:` and the hex SHA-256 of the canonical JSON of its name,
 * title, description, input and output schemas and annotations under a format tag. Absent
 * optional fields hash as `null`; `_meta`, `icons` and every other key are excluded. Callers
 * pass the definition as parsed by the MCP SDK, so the hash is over the SDK-parsed definition.
 */
export function mcpToolHash(tool: McpToolDefinition): string {
  const canonical = canonicalJson({
    format: TOOL_HASH_FORMAT,
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? null,
    annotations: tool.annotations ?? null,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
