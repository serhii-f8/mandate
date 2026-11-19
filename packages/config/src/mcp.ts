/**
 * MCP-backed operations in configuration (CONN-1, CONN-4; design phase 9 §2, §3, §4): the
 * `upstream: { tool, pin }` variant, the tool catalog listed at load and the pin state of
 * a binding. The pin is the `mcpToolHash` of the tool definition as reviewed; the
 * operation runs only while the live definition hashes to it. The hash is computed over
 * the definition as the MCP SDK parsed it (ADR 0051 F14), never over raw upstream bytes.
 */
import { mcpToolHash, type ReadErrorCode, type ToolListOutcome } from '@aiops/connector-sdk';
import { z } from 'zod';
import type { ArgumentValidator } from './argument-validators.js';
import type { McpOperationBinding } from './registry.js';
import type { UpstreamConfig } from './upstream-schema.js';

/** Upstream tool names the platform binds or lists; other listed names are dropped. Same set as the design's `[A-Za-z0-9_.\/-]`. */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_./-]{1,128}$/;
/** A tool hash as `mcpToolHash` (`@aiops/connector-sdk`) returns it. */
export const PIN_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** More tools in one list make the list `invalid_response`. */
export const MAX_MCP_TOOLS = 1000;
/** Deepest schema nesting a derived schema may have (the root is level 1). */
export const MAX_SCHEMA_DEPTH = 32;

export const mcpUpstreamSchema = z.strictObject({
  tool: z.string().regex(MCP_TOOL_NAME),
  pin: z.string().regex(PIN_PATTERN),
});
export type McpUpstreamConfig = z.output<typeof mcpUpstreamSchema>;

export function isMcpUpstream(u: UpstreamConfig | McpUpstreamConfig): u is McpUpstreamConfig {
  return Object.hasOwn(u, 'tool');
}

export interface McpCatalogTool {
  readonly name: string;
  readonly hash: string;
  /** Derived (R3); undefined when not derivable. */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

/** What the last tool list of an `mcp` connection gave: its tools, the failure code, or `skipped` (no lister). */
export type McpCatalogState =
  | { readonly status: 'listed'; readonly listedAt: number; readonly tools: readonly McpCatalogTool[]; readonly dropped: number }
  | { readonly status: 'unlisted'; readonly code: ReadErrorCode }
  | { readonly status: 'skipped' };

/** Only `ok` is offered and callable; `changed`/`missing` refuse as `upstream_changed`, the others as `upstream_unavailable`. */
export type PinState = 'ok' | 'changed' | 'missing' | 'unverified' | 'schema_invalid';

export interface PinEvaluation {
  readonly state: PinState;
  readonly liveHash: string | null;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly validator?: ArgumentValidator;
}

/** Keywords whose value is one schema. */
const SCHEMA_KEYWORDS = new Set([
  'additionalProperties',
  'propertyNames',
  'items',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedProperties',
  'unevaluatedItems',
]);
/** Keywords whose value is an array of schemas. */
const SCHEMA_ARRAY_KEYWORDS = new Set(['prefixItems', 'anyOf', 'oneOf', 'allOf']);
/** Keywords whose value maps names (not keywords) to schemas. */
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'dependentSchemas']);
/** Keywords whose value is data (copied as JSON), not a schema. */
const VALUE_KEYWORDS = new Set([
  'type',
  'required',
  'minContains',
  'maxContains',
  'minItems',
  'maxItems',
  'uniqueItems',
  'enum',
  'const',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'dependentRequired',
  'minProperties',
  'maxProperties',
  '$ref',
]);

/** Thrown inside the derivation when the schema cannot be derived; never escapes it. */
class NotDerivable extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A JSON value copied; anything else (or nesting past the limit) is not derivable. */
function copyValue(value: unknown, level: number): unknown {
  if (level > MAX_SCHEMA_DEPTH) throw new NotDerivable();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NotDerivable();
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => copyValue(v, level + 1));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyValue(v, level + 1)]));
  throw new NotDerivable();
}

/** One schema (object or boolean) with only allow-listed keywords, at nesting `level`. */
function deriveSchema(schema: unknown, level: number): unknown {
  if (level > MAX_SCHEMA_DEPTH) throw new NotDerivable();
  if (typeof schema === 'boolean') return schema;
  if (!isPlainObject(schema)) throw new NotDerivable();
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_KEYWORDS.has(key)) entries.push([key, deriveSchema(value, level + 1)]);
    else if (SCHEMA_ARRAY_KEYWORDS.has(key)) {
      if (!Array.isArray(value)) throw new NotDerivable();
      entries.push([key, value.map((s) => deriveSchema(s, level + 1))]);
    } else if (SCHEMA_MAP_KEYWORDS.has(key)) {
      if (!isPlainObject(value)) throw new NotDerivable();
      entries.push([key, Object.fromEntries(Object.entries(value).map(([name, s]) => [name, deriveSchema(s, level + 1)]))]);
    } else if (VALUE_KEYWORDS.has(key)) entries.push([key, copyValue(value, level)]);
    // Every other key (description, title, examples, default, $comment, x-*, unknown) is dropped (SEC-6).
  }
  // `Object.fromEntries` defines own data properties, so a name such as `__proto__` stays a name.
  return Object.fromEntries(entries);
}

/**
 * The input schema offered for a tool (SEC-6, ADR 0051 item 3): only the JSON Schema
 * 2020-12 validation keywords survive, at every level, so no upstream prose or unknown
 * key reaches a client. `undefined` when the root is not `type: 'object'`, the nesting is
 * deeper than 32 levels, or a keyword has a value of the wrong shape.
 */
export function deriveMcpInputSchema(schema: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isPlainObject(schema) || schema.type !== 'object') return undefined;
  try {
    return deriveSchema(schema, 1) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof NotDerivable) return undefined;
    throw error;
  }
}

const UNLISTED_INVALID: McpCatalogState = Object.freeze({ status: 'unlisted', code: 'invalid_response' });

/**
 * The catalog of one tool list (CONN-1, CONN-4). Tools with names outside `MCP_TOOL_NAME`
 * are dropped and counted; duplicate names or more than 1000 tools make the whole list
 * `invalid_response`. Each hash is recomputed from the definition, so a pin is checked
 * against what was listed, not against what the adapter claims.
 */
export function toMcpCatalog(outcome: ToolListOutcome, listedAt: number): McpCatalogState {
  if (!outcome.ok) return { status: 'unlisted', code: outcome.code };
  if (outcome.tools.length > MAX_MCP_TOOLS) return UNLISTED_INVALID;
  const tools: McpCatalogTool[] = [];
  const names = new Set<string>();
  let dropped = outcome.dropped;
  for (const { definition } of outcome.tools) {
    if (!MCP_TOOL_NAME.test(definition.name)) {
      dropped++;
      continue;
    }
    if (names.has(definition.name)) return UNLISTED_INVALID;
    names.add(definition.name);
    let hash: string;
    try {
      hash = mcpToolHash(definition);
    } catch (error) {
      // canonicalJson refuses values JSON cannot carry: the list is not a valid answer.
      if (error instanceof TypeError) return UNLISTED_INVALID;
      throw error;
    }
    const inputSchema = deriveMcpInputSchema(definition.inputSchema);
    tools.push({ name: definition.name, hash, ...(inputSchema === undefined ? {} : { inputSchema }) });
  }
  return { status: 'listed', listedAt, tools, dropped };
}

/**
 * The state of one binding against one catalog (CONN-4). Pure. When the tool's hash
 * equals the pin and the binding takes its schema from the tool, the derived schema is
 * compiled with `compile`; a schema that is not derivable or does not compile (remote
 * `$ref` included) is `schema_invalid`, never a load issue (ADR 0051 item 1).
 */
export function pinStateOf(
  binding: McpOperationBinding,
  catalog: McpCatalogState | undefined,
  compile: (s: Readonly<Record<string, unknown>>) => ArgumentValidator,
): PinEvaluation {
  if (catalog?.status !== 'listed') return { state: 'unverified', liveHash: null };
  const tool = catalog.tools.find((t) => t.name === binding.tool);
  if (tool === undefined) return { state: 'missing', liveHash: null };
  if (tool.hash !== binding.pin) return { state: 'changed', liveHash: tool.hash };
  if (!binding.schemaFromTool) return { state: 'ok', liveHash: tool.hash };
  if (tool.inputSchema === undefined) return { state: 'schema_invalid', liveHash: tool.hash };
  let validator: ArgumentValidator;
  try {
    validator = compile(tool.inputSchema);
  } catch {
    // Any compile failure (Ajv strict mode, unresolvable $ref) leaves the tool unusable, fail closed.
    return { state: 'schema_invalid', liveHash: tool.hash };
  }
  return { state: 'ok', liveHash: tool.hash, inputSchema: tool.inputSchema, validator };
}
