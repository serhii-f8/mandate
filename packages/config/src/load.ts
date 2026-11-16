/**
 * Loads a configuration directory (CFG-1) as one unit: either every file is
 * valid and cross-checked, or the result is the full list of located issues
 * and nothing is loaded (CFG-2). ADR 0015.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { GrantDefinition, OperationDefinition, PolicyConfiguration, RoleDefinition } from '@aiops/core';
import { createSchemaCompiler, type ArgumentValidator } from './argument-validators.js';
import { pathToString, type ConfigIssue } from './issues.js';
import {
  configDocumentSchema,
  schemaIssues,
  type ConfigDocument,
  type ConnectionConfig,
  type NotificationConfig,
  type OperationConfig,
  type PresetConfig,
  type RoleApproval,
  type RoleConfig,
  type RoleLimits,
} from './schema.js';
import { findSecretKeys, SECRET_MESSAGE } from './secrets.js';
import { parseYamlSource, type SourceDocument } from './yaml-source.js';

/** Names of the platform's own tools (MCP-8 and `ping`); operations may not take them. */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  'ping',
  'list_my_operations',
  'get_changeset',
  'submit_for_approval',
  'cancel_changeset',
  'rollback_changeset',
];

export interface LoadedConfiguration {
  readonly policy: PolicyConfiguration;
  /** Compiled input-schema validator per operation ID (MCP-3). */
  readonly validators: ReadonlyMap<string, ArgumentValidator>;
  readonly connections: readonly ConnectionConfig[];
  readonly presets: readonly PresetConfig[];
  readonly notifications: readonly NotificationConfig[];
  readonly limits: ReadonlyMap<string, RoleLimits>;
  readonly approval: ReadonlyMap<string, RoleApproval>;
  /** SHA-256 over the sorted files (CFG-4 records it from Phase 8). */
  readonly hash: string;
}

export type LoadResult =
  | { readonly ok: true; readonly configuration: LoadedConfiguration }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

export interface LoadOptions {
  readonly reservedToolNames?: readonly string[];
}

interface Located<T> {
  readonly value: T;
  readonly source: SourceDocument;
  readonly path: readonly PropertyKey[];
}

const YAML_FILE = /\.ya?ml$/i;

export async function loadConfigurationDirectory(dir: string, options: LoadOptions = {}): Promise<LoadResult> {
  let names: string[];
  try {
    // Hidden files and directories (editor lock files, `..data` copies) are not configuration.
    names = (await readdir(dir, { recursive: true })).filter((n) => YAML_FILE.test(n) && !n.split(sep).some((part) => part.startsWith('.')));
  } catch {
    return { ok: false, issues: [{ file: '.', path: '', message: 'configuration directory cannot be read' }] };
  }
  const read = await Promise.all(
    names.map(async (name) => {
      const file = name.split(sep).join('/');
      try {
        return { file, text: await readFile(join(dir, name), 'utf8') };
      } catch {
        return { file, issue: { file, path: '', message: 'cannot be read' } satisfies ConfigIssue };
      }
    }),
  );
  const unreadable = read.flatMap((r) => ('issue' in r ? [r.issue] : []));
  if (unreadable.length > 0) return { ok: false, issues: unreadable };
  return loadConfigurationSources(
    read.flatMap((r) => ('text' in r ? [{ file: r.file, text: r.text }] : [])),
    options,
  );
}

export function loadConfigurationSources(sources: readonly { file: string; text: string }[], options: LoadOptions = {}): LoadResult {
  const sorted = [...sources].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  if (sorted.length === 0) {
    return { ok: false, issues: [{ file: '.', path: '', message: 'no configuration files (*.yaml, *.yml) found' }] };
  }
  const issues: ConfigIssue[] = [];
  const at = (source: SourceDocument, path: readonly PropertyKey[], message: string): void => {
    issues.push({ file: source.file, path: pathToString(path), ...(source.locate(path) ?? {}), message });
  };

  const documents: { source: SourceDocument; doc: ConfigDocument }[] = [];
  for (const { file, text } of sorted) {
    const parsed = parseYamlSource(file, text);
    issues.push(...parsed.issues);
    const source = parsed.document;
    if (source === undefined) continue;
    for (const path of findSecretKeys(source.value)) at(source, path, SECRET_MESSAGE);
    const result = configDocumentSchema.safeParse(source.value ?? {});
    for (const issue of schemaIssues(result)) at(source, issue.path, issue.message);
    if (result.success) documents.push({ source, doc: result.data });
  }
  if (issues.length > 0) return { ok: false, issues };

  const collect = <T>(key: 'connections' | 'operations' | 'roles' | 'role_mapping' | 'presets' | 'notifications') =>
    documents.flatMap(({ source, doc }) =>
      ((doc[key] ?? []) as T[]).map((value, index): Located<T> => ({ value, source, path: [key, index] })),
    );
  const connections = collect<ConnectionConfig>('connections');
  const operations = collect<OperationConfig>('operations');
  const roles = collect<RoleConfig>('roles');
  const mapping = collect<{ group: string; roles: string[] }>('role_mapping');
  const presets = collect<PresetConfig>('presets');
  const notifications = collect<NotificationConfig>('notifications');

  const indexById = <T extends { id: string }>(items: readonly Located<T>[]): Map<string, Located<T>> => {
    const byId = new Map<string, Located<T>>();
    for (const item of items) {
      const first = byId.get(item.value.id);
      if (first === undefined) byId.set(item.value.id, item);
      else at(item.source, [...item.path, 'id'], `duplicate ID; first defined in ${first.source.file} at ${pathToString(first.path)}`);
    }
    return byId;
  };
  const connectionById = indexById(connections);
  const operationById = indexById(operations);
  const roleById = indexById(roles);
  const presetById = indexById(presets);
  indexById(notifications);

  const reserved = new Set(options.reservedToolNames ?? BUILTIN_TOOL_NAMES);
  const compile = createSchemaCompiler();
  const validators = new Map<string, ArgumentValidator>();

  for (const { value: c, source, path } of connections) {
    if (c.preset !== undefined && !presetById.has(c.preset)) at(source, [...path, 'preset'], 'names a preset that is not defined');
  }

  for (const { value: op, source, path } of operations) {
    if (reserved.has(op.id)) at(source, [...path, 'id'], 'is reserved for a built-in tool');
    if (!connectionById.has(op.connection)) at(source, [...path, 'connection'], 'names a connection that is not defined');
    const properties = propertiesOf(op.input_schema);
    if (op.input_schema.type !== 'object') at(source, [...path, 'input_schema'], 'root must be type: object');
    else {
      try {
        validators.set(op.id, compile(op.input_schema));
      } catch (error) {
        // Ajv's message names the schema problem (keyword, path), not argument data.
        at(source, [...path, 'input_schema'], `is not a valid JSON Schema 2020-12: ${error instanceof Error ? error.message : 'compile failed'}`);
      }
    }
    if (op.fields_arg !== undefined && (!properties.has(op.fields_arg) || !requiredOf(op.input_schema).has(op.fields_arg))) {
      at(source, [...path, 'fields_arg'], 'must name a required property of input_schema');
    }
  }

  for (const { value: role, source, path } of roles) {
    const grantIds = new Set<string>();
    role.grants.forEach((grant, index) => {
      const gPath = [...path, 'grants', index];
      if (grant.id !== undefined) {
        if (grantIds.has(grant.id)) at(source, [...gPath, 'id'], 'duplicate grant ID in this role');
        grantIds.add(grant.id);
      }
      const op = operationById.get(grant.operation)?.value;
      if (op === undefined) {
        at(source, [...gPath, 'operation'], 'names an operation that is not defined');
        return;
      }
      const properties = propertiesOf(op.input_schema);
      for (const arg of Object.keys(grant.scope)) {
        if (!properties.has(arg)) at(source, [...gPath, 'scope', arg], `is not an argument of operation ${op.id}`);
      }
      if (op.fields_arg === undefined) {
        if (grant.deny_fields.length > 0) at(source, [...gPath, 'deny_fields'], `operation ${op.id} declares no fields_arg`);
        if (grant.allow_fields !== undefined) at(source, [...gPath, 'allow_fields'], `operation ${op.id} declares no fields_arg`);
      }
    });
    const approver = role.approval?.approver_role;
    if (approver !== undefined && !roleById.has(approver)) at(source, [...path, 'approval', 'approver_role'], 'names a role that is not defined');
  }

  for (const { value: entry, source, path } of mapping) {
    entry.roles.forEach((r, index) => {
      if (!roleById.has(r)) at(source, [...path, 'roles', index], 'names a role that is not defined');
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  const hash = createHash('sha256');
  for (const { file, text } of sorted) hash.update(file).update('\0').update(text).update('\0');

  return {
    ok: true,
    configuration: {
      policy: {
        operations: operations.map(({ value }) => toOperation(value)),
        roles: roles.map(({ value }) => toRole(value)),
        roleMapping: mapping.map(({ value }) => ({ group: value.group, roles: [...value.roles] })),
      },
      validators,
      connections: connections.map((c) => c.value),
      presets: presets.map((p) => p.value),
      notifications: notifications.map((n) => n.value),
      limits: new Map(roles.flatMap(({ value }) => (value.limits === undefined ? [] : [[value.id, value.limits] as const]))),
      approval: new Map(roles.flatMap(({ value }) => (value.approval === undefined ? [] : [[value.id, value.approval] as const]))),
      hash: hash.digest('hex'),
    },
  };
}

function propertiesOf(schema: Readonly<Record<string, unknown>>): Set<string> {
  const properties = schema.properties;
  return new Set(typeof properties === 'object' && properties !== null ? Object.keys(properties) : []);
}

function requiredOf(schema: Readonly<Record<string, unknown>>): Set<string> {
  const required = schema.required;
  return new Set(Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : []);
}

function toOperation(op: OperationConfig): OperationDefinition {
  return {
    id: op.id,
    connection: op.connection,
    risk: op.risk,
    ...(op.title === undefined ? {} : { title: op.title }),
    description: op.description,
    inputSchema: op.input_schema,
    ...(op.fields_arg === undefined ? {} : { fieldsArg: op.fields_arg }),
  };
}

function toRole(role: RoleConfig): RoleDefinition {
  return {
    id: role.id,
    ...(role.description === undefined ? {} : { description: role.description }),
    grants: role.grants.map(
      (g): GrantDefinition => ({
        operation: g.operation,
        ...(g.id === undefined ? {} : { id: g.id }),
        scope: g.scope,
        denyFields: g.deny_fields,
        ...(g.allow_fields === undefined ? {} : { allowFields: g.allow_fields }),
      }),
    ),
  };
}
