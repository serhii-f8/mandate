/**
 * The operation registry (design part 1 §3.2, §3.3, §5; OPS-1, MCP-9, CONN-2): turns
 * configured and preset operations into enabled operation definitions, input
 * validators and upstream bindings, applies overrides, checks tool names and lists
 * the catalog entries and listed MCP tools nothing binds as disabled operations.
 */
import type { CatalogEntry, HttpMethod, UpstreamMapping } from '@aiops/connector-sdk';
import { isOpaque, type DisabledOperation, type OperationDefinition } from '@aiops/core';
import type { ArgumentValidator } from './argument-validators.js';
import { pathToString } from './issues.js';
import type { OverrideConfig, PresetOperationConfig } from './schema.js';
import type { SourceDocument } from './yaml-source.js';
import { toManifestDefinition } from './manifest.js';
import { isMcpUpstream, type McpCatalogState, type McpUpstreamConfig } from './mcp.js';
import { hasTemplates, pathPlaceholders, templateArgs, toBulkMapping, toResponse, toUpstreamMapping, type UpstreamConfig } from './upstream-schema.js';

export interface Located<T> {
  readonly value: T;
  readonly source: SourceDocument;
  readonly path: readonly PropertyKey[];
}

export type At = (source: SourceDocument, path: readonly PropertyKey[], message: string) => void;

/** One operation from configuration or from a preset, with the connection it is bound to. */
export interface OperationSource extends Located<PresetOperationConfig> {
  readonly connection: string;
  /** `config` or `preset:<id>`. */
  readonly origin: string;
}

/**
 * What is known about a connection's spec: `none` (no spec declared), `skipped` (no
 * resolver), `failed` (issues already reported) or the resolved catalog.
 */
export type CatalogState =
  | { readonly status: 'none' | 'skipped' | 'failed' }
  | { readonly status: 'resolved'; readonly entries: readonly CatalogEntry[] };

/** The upstream call of an enabled operation of an `openapi` connection: its connection and complete mapping. */
export interface HttpOperationBinding {
  readonly kind: 'http';
  readonly connection: string;
  readonly mapping: UpstreamMapping & { method: HttpMethod; path: string };
}

/** The upstream tool of an enabled operation of an `mcp` connection (CONN-1, CONN-4). */
export interface McpOperationBinding {
  readonly kind: 'mcp';
  readonly connection: string;
  readonly tool: string;
  /** The reviewed tool hash; the operation runs only while the live tool hashes to it. */
  readonly pin: string;
  /** True when `input_schema` is absent: the schema is derived from the pinned tool at run time. */
  readonly schemaFromTool: boolean;
}

export type OperationBinding = HttpOperationBinding | McpOperationBinding;

export interface RegisteredOperation {
  readonly definition: OperationDefinition;
  readonly located: OperationSource;
  readonly enabled: boolean;
  /** False when the input schema is a placeholder because the spec could not be read. */
  readonly schemaKnown: boolean;
  readonly validator?: ArgumentValidator;
}

export interface Registry {
  /** Every operation by ID, disabled ones included. */
  readonly all: ReadonlyMap<string, RegisteredOperation>;
  readonly enabled: readonly OperationDefinition[];
  readonly validators: ReadonlyMap<string, ArgumentValidator>;
  readonly bindings: ReadonlyMap<string, OperationBinding>;
  readonly disabled: readonly DisabledOperation[];
}

export interface RegistryInput {
  /** Unique by ID (duplicates are reported before). */
  readonly operations: readonly OperationSource[];
  readonly overrides: readonly Located<OverrideConfig>[];
  readonly catalogs: ReadonlyMap<string, CatalogState>;
  /** The tool list of each `mcp` connection at load (CONN-1); listed tools nothing binds become disabled entries. */
  readonly mcpCatalogs?: ReadonlyMap<string, McpCatalogState>;
  readonly connectionIds: ReadonlySet<string>;
  /** The adapter of each defined connection: decides which `upstream` variant its operations need. */
  readonly connectionKinds: ReadonlyMap<string, 'openapi' | 'mcp'>;
  /** A bound preset failed to load, so an unknown operation ID may be one of its operations. */
  readonly operationsIncomplete?: boolean;
  readonly reserved: ReadonlySet<string>;
  readonly compile: (schema: Readonly<Record<string, unknown>>) => ArgumentValidator;
  readonly at: At;
}

/** Schema of a derived operation whose spec is not available (no resolver). */
export const PLACEHOLDER_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({ type: 'object', additionalProperties: false });

export function buildRegistry(input: RegistryInput): Registry {
  const { at } = input;
  const overrideByOp = indexOverrides(input);

  const all = new Map<string, RegisteredOperation>();
  const validators = new Map<string, ArgumentValidator>();
  const bindings = new Map<string, OperationBinding>();
  const disabled: DisabledOperation[] = [];
  /** Catalog entry keys already accounted for: used by an enabled operation, or listed with a disabled one. */
  const used = new Set<string>();
  /** `<connection>\0<tool>` → the operation that binds it. */
  const boundTools = new Map<string, string>();

  /** Compiles an input schema whose root must be an object; reports at `schemaAt`. */
  const compileAt = (schema: Readonly<Record<string, unknown>>, source: SourceDocument, schemaAt: readonly PropertyKey[], explicit: boolean): ArgumentValidator | undefined => {
    if (schema.type !== 'object') {
      at(source, schemaAt, explicit ? 'root must be type: object' : 'derived input schema root is not type: object');
      return undefined;
    }
    try {
      return input.compile(schema);
    } catch (error) {
      // Ajv's message names the schema problem (keyword, path), not argument data.
      at(source, schemaAt, `is not a valid JSON Schema 2020-12: ${error instanceof Error ? error.message : 'compile failed'}`);
      return undefined;
    }
  };

  /** The policy definition with overrides applied (MCP-9, OPS-1). */
  const definitionOf = (located: OperationSource, schema: Readonly<Record<string, unknown>>): { definition: OperationDefinition; enabled: boolean } => {
    const op = located.value;
    const override = overrideByOp.get(op.id)?.value;
    // OPS-2: `fields_arg` of a manifest operation defaults to `values_arg`.
    const fieldsArg = op.fields_arg ?? op.manifest?.values_arg;
    const definition: OperationDefinition = {
      id: op.id,
      toolName: override?.tool_name ?? op.id,
      source: located.origin,
      connection: located.connection,
      risk: op.risk,
      ...(override?.title !== undefined ? { title: override.title } : op.title !== undefined ? { title: op.title } : {}),
      description: override?.description ?? op.description,
      inputSchema: schema,
      ...(fieldsArg === undefined ? {} : { fieldsArg }),
      ...(op.manifest === undefined ? {} : { manifest: toManifestDefinition(op.manifest) }),
    };
    return { definition, enabled: override?.enabled ?? true };
  };

  /**
   * An MCP-backed operation (CONN-1). Without `input_schema` its schema is derived from the
   * pinned tool at run time (ADR 0051 R2): a placeholder here, no validator, and grant
   * scope checks skipped as for an unresolved spec.
   */
  const registerMcp = (located: OperationSource, u: McpUpstreamConfig): void => {
    const { value: op, source, path, connection } = located;
    const explicit = op.input_schema !== undefined;
    const schema: Readonly<Record<string, unknown>> = op.input_schema ?? PLACEHOLDER_SCHEMA;
    const validator = explicit ? compileAt(schema, source, [...path, 'input_schema'], true) : undefined;
    const { definition, enabled } = definitionOf(located, schema);
    all.set(op.id, { definition, located, enabled, schemaKnown: explicit, ...(validator === undefined ? {} : { validator }) });
    if (enabled) {
      if (validator !== undefined) validators.set(op.id, validator);
      bindings.set(op.id, { kind: 'mcp', connection, tool: u.tool, pin: u.pin, schemaFromTool: !explicit });
    } else {
      disabled.push({ key: op.id, connection, method: 'MCP', path: u.tool, tool: u.tool });
    }
  };

  /** An operation whose upstream is refused: its definition only, no binding. */
  const registerUnbound = (located: OperationSource): void => {
    const { value: op, source, path } = located;
    const explicit = op.input_schema !== undefined;
    const schema: Readonly<Record<string, unknown>> = op.input_schema ?? PLACEHOLDER_SCHEMA;
    const validator = explicit ? compileAt(schema, source, [...path, 'input_schema'], true) : undefined;
    const { definition, enabled } = definitionOf(located, schema);
    all.set(op.id, { definition, located, enabled, schemaKnown: explicit, ...(validator === undefined ? {} : { validator }) });
  };

  for (const located of input.operations) {
    const { value: op, source, path, connection } = located;
    const u = op.upstream;
    const upstreamAt = (sub: readonly PropertyKey[], message: string): void => {
      at(source, [...path, 'upstream', ...sub], message);
    };
    if (input.reserved.has(op.id)) at(source, [...path, 'id'], 'is reserved for a built-in tool');
    const kind = input.connectionKinds.get(connection);

    // Before any HTTP rule: none of them applies to an MCP tool (ADR 0050 decision 7).
    if (isMcpUpstream(u)) {
      if (kind === 'openapi') upstreamAt(['tool'], 'is allowed only for operations of an mcp connection');
      if (op.risk === 'write') at(source, [...path, 'risk'], 'write needs a manifest, which MCP-backed operations cannot carry (use read, write_opaque or destructive)');
      if (op.manifest !== undefined) at(source, [...path, 'manifest'], 'is not allowed on an MCP-backed operation');
      if (op.fields_arg !== undefined) at(source, [...path, 'fields_arg'], 'is not allowed on an MCP-backed operation');
      const toolKey = `${connection}\0${u.tool}`;
      const boundBy = boundTools.get(toolKey);
      if (boundBy !== undefined) upstreamAt(['tool'], `tool ${u.tool} of connection ${connection} is already bound by operation ${boundBy}`);
      else boundTools.set(toolKey, op.id);
      registerMcp(located, u);
      continue;
    }
    if (kind === 'mcp') {
      upstreamAt([], 'an operation of an mcp connection needs upstream: { tool, pin }');
      // None of the HTTP rules below applies to an MCP connection: registered without a binding, so
      // grants naming it are not also reported as naming an undefined operation.
      registerUnbound(located);
      continue;
    }

    // Resolve `upstream.operation` against the connection's catalog.
    let entry: CatalogEntry | undefined;
    if (u.operation !== undefined && input.connectionIds.has(connection)) {
      const catalog = input.catalogs.get(connection) ?? { status: 'none' };
      if (catalog.status === 'none') upstreamAt(['operation'], 'the connection has no OpenAPI spec');
      else if (catalog.status === 'resolved') {
        entry = catalog.entries.find((e) => e.operationId === u.operation || `${e.method} ${e.path}` === u.operation);
        if (entry === undefined) upstreamAt(['operation'], "is not an operation of the connection's spec");
      }
    }

    // Input schema: declared, or derived from the catalog entry (CONN-2).
    const explicit = op.input_schema !== undefined;
    if (!explicit) {
      if (u.operation === undefined) at(source, [...path, 'input_schema'], 'is required for an operation with method and path');
      else if (hasTemplates(u)) at(source, [...path, 'input_schema'], 'is required when upstream declares templates');
    }
    const schemaKnown = explicit || entry !== undefined;
    const schema: Readonly<Record<string, unknown>> = op.input_schema ?? entry?.inputSchema ?? PLACEHOLDER_SCHEMA;
    const schemaAt: readonly PropertyKey[] = explicit ? [...path, 'input_schema'] : [...path, 'upstream', 'operation'];

    const validator = compileAt(schema, source, schemaAt, explicit);

    if (schemaKnown) {
      const properties = propertiesOf(schema);
      for (const ref of templateArgs(u)) {
        if (!properties.has(ref.arg)) upstreamAt(ref.path, 'names an argument that is not in input_schema');
      }
      if (op.fields_arg !== undefined && (!properties.has(op.fields_arg) || !requiredOf(schema).has(op.fields_arg))) {
        at(source, [...path, 'fields_arg'], 'must name a required property of input_schema');
      }
    }

    // Path placeholders of an explicit mapping (a derived one comes from the spec).
    const requestPath = u.path ?? entry?.path;
    if (explicit && requestPath !== undefined) {
      const placeholders = pathPlaceholders(requestPath);
      const params = u.path_params ?? {};
      for (const name of placeholders) {
        if (!Object.hasOwn(params, name)) upstreamAt([u.path === undefined ? 'operation' : 'path'], `placeholder {${name}} has no path_params entry`);
      }
      for (const name of Object.keys(params)) {
        if (!placeholders.includes(name)) upstreamAt(['path_params', name], 'is not a placeholder in path');
      }
    }

    // POL-3: field rules and response projection must use the same argument, so a
    // field the policy checks is also the field list the response is cut to.
    // A manifest operation's field list is its values argument and nothing is projected:
    // its fields_arg is checked with the manifest (OPS-2, manifest.ts).
    const projectedBy = u.response?.fields_from_arg;
    if (op.manifest === undefined && op.fields_arg !== undefined && projectedBy !== op.fields_arg) {
      at(source, [...path, 'fields_arg'], 'must equal upstream.response.fields_from_arg, so the response is projected by the same argument');
    } else if (op.manifest === undefined && op.fields_arg === undefined && projectedBy !== undefined) {
      upstreamAt(['response', 'fields_from_arg'], 'requires fields_arg naming the same argument');
    }

    const binding = bindingOf(connection, op, u, entry);
    const { definition, enabled } = definitionOf(located, schema);
    const opaque = isOpaque(definition);
    // A non-GET call labelled read would skip the change-set path (MCP-4).
    const method = binding?.mapping.method ?? u.method;
    const methodAt = [u.method === undefined ? 'operation' : 'method'];
    if (op.risk === 'read' && method !== undefined && method !== 'GET') {
      at(source, [...path, 'risk'], 'read operations must use GET; writes need change-sets');
    }
    // OPS-1: an opaque call is sent once as a write; a GET would be a read without a change-set.
    if (opaque && method === 'GET') upstreamAt(methodAt, 'must not be GET for a write without a manifest');
    // EXE-4: only an opaque call is resent with its key; a manifest write has its own submission record.
    if (u.idempotency !== undefined && !opaque) {
      upstreamAt(['idempotency'], 'is allowed only on write_opaque operations and destructive operations without a manifest');
    }
    // R9: the key header must not collide with a header the binding sends, spec-derived ones included.
    const keyHeader = u.idempotency?.header.toLowerCase();
    if (keyHeader !== undefined && Object.keys(binding?.mapping.headers ?? {}).some((name) => name.toLowerCase() === keyHeader)) {
      upstreamAt(['idempotency', 'header'], 'is already declared in headers');
    }
    if (u.bulk !== undefined) {
      if (op.risk !== 'write' && op.risk !== 'destructive') upstreamAt(['bulk'], 'is allowed on write and destructive operations only');
      // A bulk binding writes per record, which needs the manifest's items (OPS-6).
      else if (opaque) upstreamAt(['bulk'], 'requires a manifest');
      if (method !== undefined && method !== 'POST' && method !== 'PUT') {
        upstreamAt(methodAt, 'must be POST or PUT for a bulk binding');
      }
      for (const ref of templateArgs(u)) upstreamAt(ref.path, 'cannot reference arguments in a bulk binding');
    }
    all.set(op.id, { definition, located, enabled, schemaKnown, ...(validator === undefined ? {} : { validator }) });

    if (enabled) {
      if (validator !== undefined) validators.set(op.id, validator);
      if (binding !== undefined) bindings.set(op.id, binding);
      if (entry !== undefined) used.add(entry.key);
      else if (u.method !== undefined && u.path !== undefined) used.add(`${connection}\0${u.method} ${u.path}`);
    } else {
      // The operation's own row stands for its catalog entry, so the entry is not listed again.
      if (entry !== undefined) used.add(entry.key);
      disabled.push({
        key: op.id,
        connection,
        // Unresolved spec (no resolver): the target is not known yet.
        method: binding?.mapping.method ?? u.method ?? 'unknown',
        path: binding?.mapping.path ?? u.path ?? 'unknown',
        ...(entry?.operationId === undefined ? {} : { operationId: entry.operationId }),
        ...(entry?.summary === undefined ? {} : { summary: entry.summary }),
      });
    }
  }

  checkToolNames(input, all, overrideByOp);

  // Catalog entries nothing enabled uses are registered as disabled (CONN-2, OPS-1).
  for (const [connection, catalog] of input.catalogs) {
    if (catalog.status !== 'resolved') continue;
    for (const e of catalog.entries) {
      if (used.has(e.key) || used.has(`${connection}\0${e.method} ${e.path}`)) continue;
      disabled.push({
        key: e.key,
        connection,
        method: e.method,
        path: e.path,
        ...(e.operationId === undefined ? {} : { operationId: e.operationId }),
        ...(e.summary === undefined ? {} : { summary: e.summary }),
      });
    }
  }

  // Listed MCP tools no operation binds, enabled or disabled, are registered as disabled (CONN-1).
  for (const [connection, catalog] of input.mcpCatalogs ?? []) {
    if (catalog.status !== 'listed') continue;
    for (const tool of catalog.tools) {
      if (boundTools.has(`${connection}\0${tool.name}`)) continue;
      disabled.push({ key: `${connection}.${tool.name}`, connection, method: 'MCP', path: tool.name, tool: tool.name, hash: tool.hash });
    }
  }

  const enabled = [...all.values()].filter((r) => r.enabled).map((r) => r.definition);
  return { all, enabled, validators, bindings, disabled };
}

/**
 * The arguments the operation's mapping sends upstream (POL-2), or `undefined` when it
 * sends every argument: a derived operation without `input_schema` uses the default
 * mapping, which takes each parameter from the argument of the same name. The field
 * list argument counts too: the response is projected by it.
 */
export function sentArguments(op: PresetOperationConfig): ReadonlySet<string> | undefined {
  // An MCP tool receives the validated arguments as they are (CONN-1).
  if (isMcpUpstream(op.upstream)) return undefined;
  if (op.input_schema === undefined && op.upstream.operation !== undefined) return undefined;
  return new Set(templateArgs(op.upstream).map((ref) => ref.arg));
}

function bindingOf(connection: string, op: PresetOperationConfig, u: UpstreamConfig, entry: CatalogEntry | undefined): HttpOperationBinding | undefined {
  if (u.method !== undefined && u.path !== undefined) {
    return { kind: 'http', connection, mapping: { ...toUpstreamMapping(u), method: u.method, path: u.path } };
  }
  if (entry === undefined) return undefined; // spec not resolved: the api always resolves
  if (op.input_schema !== undefined) {
    return { kind: 'http', connection, mapping: { ...toUpstreamMapping(u), method: entry.method, path: entry.path } };
  }
  const base = entry.defaultMapping;
  return {
    kind: 'http',
    connection,
    mapping: {
      ...base,
      ...(u.operation === undefined ? {} : { operation: u.operation }),
      method: entry.method,
      path: entry.path,
      response: u.response === undefined ? base.response : toResponse(u.response),
      ...(u.bulk === undefined ? {} : { bulk: toBulkMapping(u.bulk) }),
      ...(u.idempotency === undefined ? {} : { idempotency: { header: u.idempotency.header } }),
    },
  };
}

function indexOverrides(input: RegistryInput): Map<string, Located<OverrideConfig>> {
  const ids = new Set(input.operations.map((o) => o.value.id));
  const byOp = new Map<string, Located<OverrideConfig>>();
  for (const o of input.overrides) {
    const target = o.value.operation;
    const first = byOp.get(target);
    if (!ids.has(target)) {
      if (input.operationsIncomplete !== true) input.at(o.source, [...o.path, 'operation'], 'names an operation that is not defined');
    } else if (first !== undefined) {
      input.at(o.source, [...o.path, 'operation'], `duplicate override; first defined in ${first.source.file} at ${pathToString(first.path)}`);
    } else byOp.set(target, o);
  }
  return byOp;
}

/**
 * Tool names are unique among enabled operations and built-in tools (MCP-9). Names
 * that come from an override are checked last, so a clash is reported at the override.
 */
function checkToolNames(input: RegistryInput, all: ReadonlyMap<string, RegisteredOperation>, overrides: ReadonlyMap<string, Located<OverrideConfig>>): void {
  const seen = new Map<string, string>();
  const enabled = [...all.values()].filter((r) => r.enabled);
  const named = (r: RegisteredOperation): Located<OverrideConfig> | undefined => {
    const o = overrides.get(r.definition.id);
    return o?.value.tool_name === undefined ? undefined : o;
  };
  for (const r of [...enabled.filter((x) => named(x) === undefined), ...enabled.filter((x) => named(x) !== undefined)]) {
    const o = named(r);
    const name = r.definition.toolName;
    if (o !== undefined && input.reserved.has(name)) {
      input.at(o.source, [...o.path, 'tool_name'], 'is reserved for a built-in tool');
      continue;
    }
    const first = seen.get(name);
    if (first !== undefined) {
      const [source, path] = o === undefined ? [r.located.source, [...r.located.path, 'id']] : [o.source, [...o.path, 'tool_name']];
      input.at(source, path, `duplicate tool name; operation ${first} already uses it`);
      continue;
    }
    seen.set(name, r.definition.id);
  }
}

export function propertiesOf(schema: Readonly<Record<string, unknown>>): Set<string> {
  const properties = schema.properties;
  return new Set(typeof properties === 'object' && properties !== null ? Object.keys(properties) : []);
}

export function requiredOf(schema: Readonly<Record<string, unknown>>): Set<string> {
  const required = schema.required;
  return new Set(Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : []);
}
