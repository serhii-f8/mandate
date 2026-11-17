/**
 * The operation registry (design part 1 §3.2, §3.3, §5; OPS-1, MCP-9, CONN-2): turns
 * configured and preset operations into enabled operation definitions, input
 * validators and upstream bindings, applies overrides, checks tool names and lists
 * the catalog entries nothing enables as disabled operations.
 */
import type { CatalogEntry, HttpMethod, UpstreamMapping } from '@aiops/connector-sdk';
import type { DisabledOperation, OperationDefinition } from '@aiops/core';
import type { ArgumentValidator } from './argument-validators.js';
import { pathToString } from './issues.js';
import type { OverrideConfig, PresetOperationConfig } from './schema.js';
import type { SourceDocument } from './yaml-source.js';
import { hasTemplates, pathPlaceholders, templateArgs, toResponse, toUpstreamMapping } from './upstream-schema.js';

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

/** The upstream call of an enabled operation: its connection and complete mapping. */
export interface OperationBinding {
  readonly connection: string;
  readonly mapping: UpstreamMapping & { method: HttpMethod; path: string };
}

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
  readonly connectionIds: ReadonlySet<string>;
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

  for (const located of input.operations) {
    const { value: op, source, path, connection } = located;
    const u = op.upstream;
    const upstreamAt = (sub: readonly PropertyKey[], message: string): void => {
      at(source, [...path, 'upstream', ...sub], message);
    };
    if (input.reserved.has(op.id)) at(source, [...path, 'id'], 'is reserved for a built-in tool');

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

    let validator: ArgumentValidator | undefined;
    if (schema.type !== 'object') at(source, schemaAt, explicit ? 'root must be type: object' : 'derived input schema root is not type: object');
    else {
      try {
        validator = input.compile(schema);
      } catch (error) {
        // Ajv's message names the schema problem (keyword, path), not argument data.
        at(source, schemaAt, `is not a valid JSON Schema 2020-12: ${error instanceof Error ? error.message : 'compile failed'}`);
      }
    }

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
    const projectedBy = u.response?.fields_from_arg;
    if (op.fields_arg !== undefined && projectedBy !== op.fields_arg) {
      at(source, [...path, 'fields_arg'], 'must equal upstream.response.fields_from_arg, so the response is projected by the same argument');
    } else if (op.fields_arg === undefined && projectedBy !== undefined) {
      upstreamAt(['response', 'fields_from_arg'], 'requires fields_arg naming the same argument');
    }

    const binding = bindingOf(connection, op, entry);
    // A non-GET call labelled read would skip the change-set path (POL-5, CS-1).
    const method = binding?.mapping.method ?? u.method;
    if (op.risk === 'read' && method !== undefined && method !== 'GET') {
      at(source, [...path, 'risk'], 'read operations must use GET; writes need change-sets');
    }
    const override = overrideByOp.get(op.id)?.value;
    const enabled = override?.enabled ?? true;
    const definition: OperationDefinition = {
      id: op.id,
      toolName: override?.tool_name ?? op.id,
      source: located.origin,
      connection,
      risk: op.risk,
      ...(override?.title !== undefined ? { title: override.title } : op.title !== undefined ? { title: op.title } : {}),
      description: override?.description ?? op.description,
      inputSchema: schema,
      ...(op.fields_arg === undefined ? {} : { fieldsArg: op.fields_arg }),
    };
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
  if (op.input_schema === undefined && op.upstream.operation !== undefined) return undefined;
  return new Set(templateArgs(op.upstream).map((ref) => ref.arg));
}

function bindingOf(connection: string, op: PresetOperationConfig, entry: CatalogEntry | undefined): OperationBinding | undefined {
  const u = op.upstream;
  if (u.method !== undefined && u.path !== undefined) {
    return { connection, mapping: { ...toUpstreamMapping(u), method: u.method, path: u.path } };
  }
  if (entry === undefined) return undefined; // spec not resolved: the api always resolves
  if (op.input_schema !== undefined) {
    return { connection, mapping: { ...toUpstreamMapping(u), method: entry.method, path: entry.path } };
  }
  const base = entry.defaultMapping;
  return {
    connection,
    mapping: {
      ...base,
      ...(u.operation === undefined ? {} : { operation: u.operation }),
      method: entry.method,
      path: entry.path,
      response: u.response === undefined ? base.response : toResponse(u.response),
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
