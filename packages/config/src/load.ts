/**
 * Loads a configuration directory (CFG-1) as one unit: either every file is
 * valid and cross-checked, or the result is the full list of located issues
 * and nothing is loaded (CFG-2). ADR 0015; presets, specs and the operation
 * registry since Phase 3 (ADR 0017).
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { CodeOperation, ConnectionSettings, CredentialScheme, SpecIssue, ToolListOutcome, UpstreamResolver } from '@aiops/connector-sdk';
import type { DisabledOperation, GrantDefinition, PolicyConfiguration, RoleApprovalRule, RoleDefinition, RoleNotifyTargets } from '@aiops/core';
import { createSchemaCompiler, type ArgumentValidator } from './argument-validators.js';
import { pathToString, type ConfigIssue } from './issues.js';
import { checkManifests, DEFAULT_EXPIRE_AFTER_HOURS, DEFAULT_FAILURE_THRESHOLD, DEFAULT_ITEMS_PER_WORKFLOW_RUN, DEFAULT_ROLLBACK_WINDOW_HOURS } from './manifest.js';
import { readSpecFile, resolvePreset, type LoadedPreset } from './presets.js';
import type { PresetOperationConfig } from './schema.js';
import { isMcpUpstream, toMcpCatalog, type McpCatalogState } from './mcp.js';
import { buildRegistry, propertiesOf, sentArguments, type CatalogState, type Located, type OperationBinding, type OperationSource } from './registry.js';
import {
  configDocumentSchema,
  PARSE_PARAMS,
  schemaIssues,
  type ConfigDocument,
  type ConnectionConfig,
  type NotificationConfig,
  type OperationConfig,
  type OverrideConfig,
  type PresetConfig,
  type RoleApproval,
  type RoleConfig,
  type RoleLimits,
} from './schema.js';
import { findSecretKeys, SECRET_MESSAGE } from './secrets.js';
import { isCodeUpstream, isSpecUrl, toAuthSettings, type AuthConfig, type ConnectionTestConfig } from './upstream-schema.js';
import { parseYamlSource, type SourceDocument } from './yaml-source.js';

/** Names of the platform's own tools (MCP-8 and `ping`); operations may not take them. */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  'ping',
  'list_my_operations',
  'get_changeset',
  'submit_for_approval',
  'cancel_changeset',
  'rollback_changeset',
  'exclude_changeset_items',
  'decide_changeset',
  'review_changeset',
];

export type { OperationBinding };

/** CONN-8: what was loaded for one preset entry. */
export interface LoadedPresetSummary {
  readonly package: string;
  readonly version: string;
  readonly adapter: 'openapi' | 'mcp';
  /** Hex SHA-256 over the preset's configuration-hash inputs (its files). */
  readonly filesDigest: string;
  /** Hex SHA-256 of the preset's code tree, when it has code (CFG-4). */
  readonly codeDigest?: string;
}

export interface LoadedConfiguration {
  /** Enabled operations only (OPS-1); `toolName` and `source` set (MCP-9). */
  readonly policy: PolicyConfiguration;
  /** Compiled input-schema validator per enabled operation ID (MCP-3). */
  readonly validators: ReadonlyMap<string, ArgumentValidator>;
  readonly connections: readonly ConnectionConfig[];
  readonly presets: readonly PresetConfig[];
  /** CONN-8: per loaded preset ID, the package and the version chosen; empty while presets are not loaded. */
  readonly loadedPresets: ReadonlyMap<string, LoadedPresetSummary>;
  readonly notifications: readonly NotificationConfig[];
  readonly limits: ReadonlyMap<string, RoleLimits>;
  readonly approval: ReadonlyMap<string, RoleApprovalRule>;
  /** NTF-1: notification targets per role; an entry only for roles that set `notify`. */
  readonly notify: RoleNotifyTargets;
  /** Upstream binding per enabled operation ID; absent while its spec was not resolved. */
  readonly bindings: ReadonlyMap<string, OperationBinding>;
  /** Catalog entries nothing enables, and operations disabled by an override (CONN-2, OPS-1). */
  readonly disabled: readonly DisabledOperation[];
  /**
   * OPS-5: the preset code-module operation of each enabled code-bound operation (binding
   * `kind: 'code'`). Not part of `hash`: the code tree's digest is (CFG-4).
   */
  readonly codeOperations: ReadonlyMap<string, CodeOperation>;
  /** Every connection's settings; `kind` is set for each (CONN-1). */
  readonly connectionSettings: ReadonlyMap<string, ConnectionSettings>;
  /** CONN-4: seconds between pin checks, per `mcp` connection only. */
  readonly pinCheckSeconds: ReadonlyMap<string, number>;
  /**
   * CONN-1, CONN-4: the tool list of each `mcp` connection at load. It only seeds pin states
   * and the disabled list: it never adds an issue and is not part of `hash` (ADR 0051 item 1).
   */
  readonly mcpCatalogs: ReadonlyMap<string, McpCatalogState>;
  /** CONN-7: the read operation and arguments that test a connection. */
  readonly connectionTests: ReadonlyMap<string, { readonly operation: string; readonly args: Readonly<Record<string, unknown>> }>;
  /** Credential reference → its scheme and the connections and webhook notifications that use it (SEC-2). */
  readonly credentialRefs: ReadonlyMap<
    string,
    { readonly scheme: CredentialScheme; readonly connections: readonly string[]; readonly notifications: readonly string[] }
  >;
  /** Role → credential references it may manage (`*` for all). */
  readonly credentialManagers: ReadonlyMap<string, readonly string[]>;
  /** True when presets were declared but not loaded because no preset directories were given. */
  readonly presetChecksSkipped: boolean;
  /** True when specs were declared but not resolved because no resolver was given. */
  readonly specChecksSkipped: boolean;
  /** CS-6: hours after which a prepared change-set expires. */
  /** AUD-7: absent = keep forever. */
  readonly audit: { readonly retentionDays?: number };
  /** SEC-1, AUD-6: role IDs with view_audit: true. */
  readonly auditViewers: ReadonlySet<string>;
  /** AUD-4: union of every loaded manifest's sensitive_fields (presets included). */
  readonly sensitiveFields: ReadonlySet<string>;
  readonly changesets: { readonly expireAfterHours: number; readonly failureThreshold: number; readonly itemsPerWorkflowRun: number; readonly rollbackWindowHours: number };
  /** SHA-256 over the sorted files, the preset files and the spec files (CFG-4 records it from Phase 8). */
  readonly hash: string;
  /**
   * Every configuration file and every connection-owned spec file (not presets), keyed
   * relative to the configuration directory with `/` separators. A revision stores these
   * (CFG-4); an outside spec gives a key starting with `../`.
   */
  readonly sourceFiles: ReadonlyMap<string, string>;
}

export type LoadResult =
  | { readonly ok: true; readonly configuration: LoadedConfiguration }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

export interface LoadOptions {
  readonly reservedToolNames?: readonly string[];
  /** Reads specs and derives catalogs (CONN-2). Without it, spec checks are skipped. */
  readonly resolver?: UpstreamResolver;
  /**
   * Directories holding preset packages (CONN-8 first cut). Undefined: presets are not
   * loaded and `presetChecksSkipped` is set; `[]` means none is installed.
   */
  readonly presetDirs?: readonly string[];
  /**
   * Directory the source file names are relative to, for spec paths. Set by
   * `loadConfigurationDirectory`; defaults to the working directory.
   */
  readonly baseDir?: string;
  /** Clock for `listedAt` of the MCP tool catalogs; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * How preset code modules are imported (OPS-5). Production leaves it unset: native
   * `import()`. Tests pass Node's own loader, because Vitest's module runner resolves and
   * reports differently (F23).
   */
  readonly importModule?: (url: string) => Promise<unknown>;
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
    { ...options, baseDir: resolve(dir) },
  );
}

/** Where a connection's spec comes from, and where to report its issues. */
type SpecSource =
  | { readonly kind: 'file'; readonly file: string; readonly owner: 'connection' | 'preset' }
  | { readonly kind: 'url'; readonly url: string };

interface ConnectionState {
  readonly located: Located<ConnectionConfig>;
  readonly preset?: LoadedPreset;
  readonly auth?: AuthConfig;
  readonly spec?: SpecSource;
  readonly settings: ConnectionSettings;
}

export async function loadConfigurationSources(sources: readonly { file: string; text: string }[], options: LoadOptions = {}): Promise<LoadResult> {
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
    const result = configDocumentSchema.safeParse(source.value ?? {}, PARSE_PARAMS);
    for (const issue of schemaIssues(result)) at(source, issue.path, issue.message);
    if (result.success) documents.push({ source, doc: result.data });
  }
  if (issues.length > 0) return { ok: false, issues };

  const collect = <T>(key: 'connections' | 'operations' | 'roles' | 'role_mapping' | 'presets' | 'notifications' | 'overrides') =>
    documents.flatMap(({ source, doc }) =>
      ((doc[key] ?? []) as T[]).map((value, index): Located<T> => ({ value, source, path: [key, index] })),
    );
  const connections = collect<ConnectionConfig>('connections');
  const configOperations = collect<OperationConfig>('operations');
  const roles = collect<RoleConfig>('roles');
  const mapping = collect<{ group: string; roles: string[] }>('role_mapping');
  const presets = collect<PresetConfig>('presets');
  const notifications = collect<NotificationConfig>('notifications');
  const overrides = collect<OverrideConfig>('overrides');

  const indexById = <L extends Located<{ id: string }>>(items: readonly L[]): Map<string, L> => {
    const byId = new Map<string, L>();
    for (const item of items) {
      const first = byId.get(item.value.id);
      if (first === undefined) byId.set(item.value.id, item);
      else at(item.source, [...item.path, 'id'], `duplicate ID; first defined in ${first.source.file} at ${pathToString(first.path)}`);
    }
    return byId;
  };
  // CS-6: change-set settings come from at most one document.
  let changesets: Located<{ expire_after_hours: number; failure_threshold: number; items_per_workflow_run: number; rollback_window_hours: number }> | undefined;
  for (const { source, doc } of documents) {
    if (doc.changesets === undefined) continue;
    if (changesets === undefined) changesets = { value: doc.changesets, source, path: ['changesets'] };
    else at(source, ['changesets'], `may be set in one document only; first set in ${changesets.source.file}`);
  }
  // AUD-7: audit settings come from at most one document.
  let audit: Located<{ retention_days?: number | undefined }> | undefined;
  for (const { source, doc } of documents) {
    if (doc.audit === undefined) continue;
    if (audit === undefined) audit = { value: doc.audit, source, path: ['audit'] };
    else at(source, ['audit'], `may be set in one document only; first set in ${audit.source.file}`);
  }

  const connectionById = indexById(connections);
  const roleById = indexById(roles);
  const presetById = indexById(presets);
  const notificationById = indexById(notifications);

  // Presets (CONN-8 first cut): resolve every declared preset, bind each to at most one connection.
  // Without preset directories (the static CLI) presets are not loaded, and the result says so.
  const presetChecksSkipped = options.presetDirs === undefined && presetById.size > 0;
  const resolvedPresets = new Map<string, LoadedPreset>();
  if (options.presetDirs !== undefined) {
    for (const [presetId, entry] of presetById) {
      const result = await resolvePreset(entry.value, options.presetDirs, entry, options.importModule === undefined ? {} : { importModule: options.importModule });
      if (result.ok) resolvedPresets.set(presetId, result.preset);
      else issues.push(...result.issues);
    }
  }
  // CONN-8: a preset may be bound to several connections when each binding has its own
  // effective namespace: the operation_prefix, or the preset operations' own first segments.
  const presetBoundTo = new Map<string, PresetBinding[]>();
  for (const { value: c, source, path } of connections) {
    if (c.preset === undefined) {
      if (c.operation_prefix !== undefined) at(source, [...path, 'operation_prefix'], 'requires preset');
      continue;
    }
    if (!presetById.has(c.preset)) at(source, [...path, 'preset'], 'names a preset that is not defined');
    const resolved = resolvedPresets.get(c.preset);
    const presetAdapter = resolved?.adapter;
    if (presetAdapter !== undefined && presetAdapter !== c.adapter) {
      at(source, [...path, 'preset'], `the preset is for ${presetAdapter} connections`);
      continue;
    }
    const binding: PresetBinding = { connection: c.id, ...(c.operation_prefix === undefined ? {} : { prefix: c.operation_prefix }) };
    const namespaces = bindingNamespaces(binding, resolved);
    const bindings = presetBoundTo.get(c.preset) ?? [];
    const clash = bindings.find((b) => [...bindingNamespaces(b, resolved)].some((ns) => namespaces.has(ns)));
    if (clash !== undefined) {
      at(source, [...path, 'preset'], `the preset is already bound to connection ${clash.connection} with the same operation prefix`);
      continue;
    }
    presetBoundTo.set(c.preset, [...bindings, binding]);
  }

  // All operations: configuration first, then preset operations bound to their connection.
  const operations: OperationSource[] = configOperations.map((o) => ({ ...o, connection: o.value.connection, origin: 'config' }));
  for (const [presetId, bindings] of presetBoundTo) {
    const preset = resolvedPresets.get(presetId);
    if (preset === undefined) continue;
    for (const binding of bindings) {
      const alias = presetAlias(preset, binding.prefix);
      preset.operations.forEach((value, index) => {
        operations.push({ value: alias.operation(value), source: preset.source, path: ['operations', index], connection: binding.connection, origin: `preset:${presetId}` });
      });
    }
  }
  /** A bound preset that failed to load: its operations are unknown, so "not defined" would mislead. */
  const operationsIncomplete = [...presetBoundTo.keys()].some((id) => presetById.has(id) && !resolvedPresets.has(id));
  const operationById = indexById(operations);
  for (const { value: op, source, path } of configOperations) {
    if (!connectionById.has(op.connection)) at(source, [...path, 'connection'], 'names a connection that is not defined');
  }

  // Connections: settings, auth and spec source.
  const baseDir = options.baseDir ?? process.cwd();
  const states = new Map<string, ConnectionState>();
  for (const located of connectionById.values()) {
    const { value: c, source, path } = located;
    const binding = c.preset === undefined ? undefined : presetBoundTo.get(c.preset)?.find((b) => b.connection === c.id);
    const loadedPreset = c.preset === undefined || binding === undefined ? undefined : resolvedPresets.get(c.preset);
    // The preset's test names its own operation IDs; on an aliased binding it follows the prefix.
    const preset =
      loadedPreset === undefined || binding?.prefix === undefined || loadedPreset.test === undefined
        ? loadedPreset
        : { ...loadedPreset, test: { ...loadedPreset.test, operation: presetAlias(loadedPreset, binding.prefix).id(loadedPreset.test.operation) } };
    const auth = c.auth ?? preset?.auth;
    // A preset that failed to load, or a binding already refused, leaves auth unknown: no follow-on issue.
    const presetFailed = c.preset !== undefined && presetById.has(c.preset) && (!resolvedPresets.has(c.preset) || binding === undefined);
    if (c.credential_ref !== undefined && auth === undefined && !presetFailed) at(source, [...path, 'credential_ref'], 'credential_ref requires auth');
    if (c.credential_ref === undefined && auth !== undefined) at(source, [...path, 'credential_ref'], 'is required when auth is set');
    const declared = c.adapter === 'openapi' ? c.openapi?.spec : undefined;
    let spec: SpecSource | undefined;
    if (declared !== undefined) {
      spec = isSpecUrl(declared) ? { kind: 'url', url: declared } : { kind: 'file', file: resolve(baseDir, dirname(source.file), declared), owner: 'connection' };
    } else if (preset?.specFile !== undefined) spec = { kind: 'file', file: preset.specFile, owner: 'preset' };
    const settings: ConnectionSettings = {
      id: c.id,
      kind: c.adapter,
      baseUrl: c.adapter === 'openapi' ? c.base_url : c.mcp_url,
      ...(auth === undefined ? {} : { auth: toAuthSettings(auth) }),
      ...(c.credential_ref === undefined ? {} : { credentialRef: c.credential_ref }),
      timeoutMs: c.timeout_ms,
      retry: { maxAttempts: c.retry.max_attempts, initialBackoffMs: c.retry.initial_backoff_ms },
      maxConcurrency: c.max_concurrency,
      allowPrivateNetwork: c.allow_private_network,
      extraHosts: spec?.kind === 'url' && URL.canParse(spec.url) ? [new URL(spec.url).hostname] : [],
    };
    states.set(c.id, { located, ...(preset === undefined ? {} : { preset }), ...(auth === undefined ? {} : { auth }), ...(spec === undefined ? {} : { spec }), settings });
  }

  // Specs: read connection spec files (hash, CFG-2), then resolve catalogs (CONN-2).
  const specTexts: { file: string; text: string }[] = [];
  const catalogs = new Map<string, CatalogState>();
  let specChecksSkipped = false;
  for (const state of states.values()) {
    const { located, spec } = state;
    const id = located.value.id;
    if (spec === undefined) {
      catalogs.set(id, { status: 'none' });
      continue;
    }
    if (spec.kind === 'file' && spec.owner === 'connection') {
      const read = await readSpecFile(spec.file);
      if (!read.ok) {
        at(located.source, [...located.path, 'openapi', 'spec'], read.message);
        catalogs.set(id, { status: 'failed' });
        continue;
      }
      // Relative, so the hash does not depend on where the directory is mounted.
      specTexts.push({ file: relative(baseDir, spec.file), text: read.text });
    }
    if (options.resolver === undefined) {
      specChecksSkipped = true;
      catalogs.set(id, { status: 'skipped' });
      continue;
    }
    const include = located.value.adapter === 'openapi' ? located.value.openapi?.include : undefined;
    const result = await options.resolver.resolveSpec({
      connection: state.settings,
      spec: spec.kind === 'url' ? { url: spec.url } : { file: spec.file },
      ...(include === undefined ? {} : { include }),
    });
    if (result.ok) catalogs.set(id, { status: 'resolved', entries: result.catalog });
    else {
      catalogs.set(id, { status: 'failed' });
      for (const issue of result.issues) locateSpecIssue(state, issue, at);
    }
  }

  // MCP tool lists (CONN-1): never an issue, so every process loads a revision identically (R1).
  const now = options.now ?? Date.now;
  const resolveTools = options.resolver?.resolveTools?.bind(options.resolver);
  const mcpCatalogs = new Map<string, McpCatalogState>(
    await Promise.all(
      [...states.values()]
        .filter((state) => state.located.value.adapter === 'mcp')
        .map(async ({ settings }): Promise<readonly [string, McpCatalogState]> => {
          if (resolveTools === undefined) return [settings.id, { status: 'skipped' }];
          let outcome: ToolListOutcome;
          try {
            outcome = await resolveTools({ connection: settings });
          } catch {
            // Adapters answer with outcomes; a rejection is a lister fault and must not fail the load (R1).
            return [settings.id, { status: 'unlisted', code: 'network' }];
          }
          return [settings.id, toMcpCatalog(outcome, now())];
        }),
    ),
  );
  if (resolveTools === undefined && mcpCatalogs.size > 0) specChecksSkipped = true;

  const compile = createSchemaCompiler();
  const registry = buildRegistry({
    operations: [...operationById.values()],
    overrides,
    catalogs,
    mcpCatalogs,
    connectionIds: new Set(connectionById.keys()),
    connectionKinds: new Map([...connectionById].map(([id, c]) => [id, c.value.adapter] as const)),
    codeModules: new Map([...resolvedPresets].flatMap(([id, preset]) => (preset.code === undefined ? [] : [[id, preset.code.module] as const]))),
    operationsIncomplete,
    reserved: new Set(options.reservedToolNames ?? BUILTIN_TOOL_NAMES),
    compile,
    at,
  });

  // EXE-4 SEC-2: the idempotency key must not take the connection's api_key header, which the
  // credential overwrites last, so the key would be lost without an error.
  for (const { located } of registry.all.values()) {
    const u = located.value.upstream;
    if (isMcpUpstream(u) || isCodeUpstream(u) || u.idempotency === undefined) continue;
    const auth = states.get(located.connection)?.auth;
    if (auth?.scheme === 'api_key' && auth.header.toLowerCase() === u.idempotency.header.toLowerCase()) {
      at(located.source, [...located.path, 'upstream', 'idempotency', 'header'], 'is set by the platform');
    }
  }

  // Manifests (OPS-2, OPS-3, OPS-4): need the registry's enabled operations and final schemas.
  checkManifests({ all: registry.all, operationsIncomplete, at });

  // Connection tests (CONN-7): a read operation of the same connection, with valid args.
  const connectionTests = new Map<string, { operation: string; args: Readonly<Record<string, unknown>> }>();
  for (const { located, preset } of states.values()) {
    const { value: c, source, path } = located;
    const [test, testSource, testPath]: [ConnectionTestConfig | undefined, SourceDocument, readonly PropertyKey[]] =
      c.test !== undefined ? [c.test, source, [...path, 'test']] : [preset?.test, preset?.source ?? source, ['test']];
    if (test === undefined) continue;
    const op = registry.all.get(test.operation);
    const fail = (key: 'operation' | 'args', message: string): void => {
      at(testSource, [...testPath, key], message);
    };
    if (op === undefined) {
      if (!operationsIncomplete) fail('operation', 'names an operation that is not defined');
    } else if (!op.enabled) fail('operation', 'names a disabled operation');
    else if (op.definition.risk !== 'read') fail('operation', 'must be a read operation');
    else if (op.definition.connection !== c.id) fail('operation', 'must be an operation of this connection');
    else if (op.schemaKnown && op.validator !== undefined && !op.validator(test.args).ok) fail('args', "args do not match the operation's input_schema");
    else connectionTests.set(c.id, { operation: test.operation, args: test.args });
  }

  // Credential references (SEC-2): one scheme per reference.
  const credentialRefs = new Map<string, { scheme: CredentialScheme; connections: string[]; notifications: string[] }>();
  for (const { located, auth } of states.values()) {
    const { value: c, source, path } = located;
    if (c.credential_ref === undefined || auth === undefined) continue;
    const known = credentialRefs.get(c.credential_ref);
    if (known === undefined) credentialRefs.set(c.credential_ref, { scheme: auth.scheme, connections: [c.id], notifications: [] });
    else if (known.scheme !== auth.scheme) {
      at(source, [...path, 'credential_ref'], `is used with another auth scheme by connection ${known.connections[0] ?? ''}`);
    } else known.connections.push(c.id);
  }
  // Webhook URLs are vault credentials of scheme webhook_url, registered after connection refs.
  for (const { value: n, source, path } of notificationById.values()) {
    if (n.kind !== 'webhook') continue;
    if (n.allowed_hosts === undefined || n.allowed_hosts.length === 0) {
      at(source, [...path, 'allowed_hosts'], 'is required for a webhook notification (CONN-5)');
    }
    const known = credentialRefs.get(n.url_credential_ref);
    if (known === undefined) credentialRefs.set(n.url_credential_ref, { scheme: 'webhook_url', connections: [], notifications: [n.id] });
    else if (known.scheme !== 'webhook_url') {
      at(source, [...path, 'url_credential_ref'], `is used with another scheme by connection ${known.connections[0] ?? ''}`);
    } else known.notifications.push(n.id);
  }
  // Declared refs: those of connections and of webhook notifications. A connection whose auth
  // could not be resolved still declares its ref, so manage_credentials does not report it twice.
  const declaredRefs = new Set<string>([
    ...connections.flatMap(({ value }) => (value.credential_ref === undefined ? [] : [value.credential_ref])),
    ...credentialRefs.keys(),
  ]);

  const credentialManagers = new Map<string, readonly string[]>();
  for (const { value: role, source, path } of roles) {
    const grantIds = new Set<string>();
    role.grants.forEach((grant, index) => {
      const gPath = [...path, 'grants', index];
      if (grant.id !== undefined) {
        if (grantIds.has(grant.id)) at(source, [...gPath, 'id'], 'duplicate grant ID in this role');
        grantIds.add(grant.id);
      }
      const op = registry.all.get(grant.operation);
      if (op === undefined) {
        if (!operationsIncomplete) at(source, [...gPath, 'operation'], 'names an operation that is not defined');
        return;
      }
      const { definition } = op;
      const manifest = op.located.value.manifest;
      if (op.schemaKnown) {
        const properties = propertiesOf(definition.inputSchema);
        // A manifest operation's scope reaches upstream through its reads, and the item
        // check re-checks it on every record (design phase 4 §3.1 check 4).
        const sent = manifest === undefined ? sentArguments(op.located.value) : undefined;
        for (const arg of Object.keys(grant.scope)) {
          if (!properties.has(arg)) at(source, [...gPath, 'scope', arg], `is not an argument of operation ${definition.id}`);
          // A constraint on an argument the upstream never sees restricts nothing (POL-2).
          else if (sent !== undefined && !sent.has(arg)) at(source, [...gPath, 'scope', arg], `scope argument ${arg} is not sent upstream by operation ${definition.id}`);
        }
      }
      if (manifest !== undefined) {
        for (const arg of Object.keys(grant.scope)) {
          if (!Object.hasOwn(manifest.scope_args, arg)) at(source, [...gPath, 'scope', arg], `is not in manifest.scope_args of operation ${definition.id}`);
        }
      }
      if (definition.fieldsArg === undefined) {
        if (grant.deny_fields.length > 0) at(source, [...gPath, 'deny_fields'], `operation ${definition.id} declares no fields_arg`);
        if (grant.allow_fields !== undefined) at(source, [...gPath, 'allow_fields'], `operation ${definition.id} declares no fields_arg`);
      }
    });
    const approval = role.approval;
    if (approval !== undefined) {
      approval.steps?.forEach((step, index) => {
        if (!roleById.has(step.role)) at(source, [...path, 'approval', 'steps', index, 'role'], 'names a role that is not defined');
      });
      if (approval.required === 'above_threshold' && approval.record_threshold === undefined) {
        at(source, [...path, 'approval', 'record_threshold'], 'is required with required: above_threshold');
      }
      if (approval.required !== 'above_threshold' && approval.record_threshold !== undefined) {
        at(source, [...path, 'approval', 'record_threshold'], 'is allowed only with required: above_threshold');
      }
    }
    // POL-5: a grant whose approval can be required needs someone to approve it.
    const risks = role.grants.flatMap((grant) => {
      const risk = registry.all.get(grant.operation)?.definition.risk;
      return risk === undefined ? [] : [risk];
    });
    const destructive = risks.includes('destructive');
    // write_opaque counts as a write: without steps its calls could never be approved.
    const writes = destructive || risks.includes('write') || risks.includes('write_opaque');
    const stepless = (approval?.steps ?? []).length === 0;
    if (writes && stepless && (destructive || approval?.required !== 'never')) {
      const message = 'needs at least one step: a write or destructive grant requires approval by default (set steps, or required: never for write operations)';
      at(source, approval === undefined ? [...path, 'approval'] : [...path, 'approval', 'steps'], message);
    }
    if (role.manage_credentials !== undefined) {
      role.manage_credentials.forEach((ref, index) => {
        if (ref !== '*' && !declaredRefs.has(ref)) {
          at(source, [...path, 'manage_credentials', index], 'names a credential that no connection or notification uses');
        }
      });
      credentialManagers.set(role.id, [...role.manage_credentials]);
    }
    if (role.notify !== undefined) {
      for (const list of ['approval_requests', 'results'] as const) {
        role.notify[list].forEach((target, index) => {
          if (!notificationById.has(target)) at(source, [...path, 'notify', list, index], 'names a notification that is not defined');
        });
      }
    }
  }

  for (const { value: entry, source, path } of mapping) {
    entry.roles.forEach((r, index) => {
      if (!roleById.has(r)) at(source, [...path, 'roles', index], 'names a role that is not defined');
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  const hash = createHash('sha256');
  for (const { file, text } of sorted) hash.update(file).update('\0').update(text).update('\0');
  const loadedPresets = new Map<string, LoadedPresetSummary>();
  for (const presetId of [...resolvedPresets.keys()].sort()) {
    const preset = resolvedPresets.get(presetId);
    if (preset === undefined) continue;
    // The same inputs, in the same form, as the configuration hash; `config diff` compares it (CFG-3).
    const filesDigest = createHash('sha256');
    for (const { file, text } of preset.files) {
      hash.update(`preset:${file}`).update('\0').update(text).update('\0');
      filesDigest.update(`preset:${file}`).update('\0').update(text).update('\0');
    }
    // CFG-4: the code tree's digest, after that preset's files.
    if (preset.code !== undefined) {
      hash.update(`preset-code:${preset.package}`).update('\0').update(preset.code.digest).update('\0');
      filesDigest.update(`preset-code:${preset.package}`).update('\0').update(preset.code.digest).update('\0');
    }
    loadedPresets.set(presetId, {
      package: preset.package,
      version: preset.version,
      adapter: preset.adapter,
      filesDigest: filesDigest.digest('hex'),
      ...(preset.code === undefined ? {} : { codeDigest: preset.code.digest }),
    });
  }
  for (const { file, text } of specTexts) hash.update(`spec:${file}`).update('\0').update(text).update('\0');

  return {
    ok: true,
    configuration: {
      policy: {
        operations: registry.enabled,
        roles: roles.map(({ value }) => toRole(value)),
        roleMapping: mapping.map(({ value }) => ({ group: value.group, roles: [...value.roles] })),
      },
      validators: registry.validators,
      connections: connections.map((c) => c.value),
      presets: presets.map((p) => p.value),
      loadedPresets,
      notifications: notifications.map((n) => n.value),
      limits: new Map(roles.flatMap(({ value }) => (value.limits === undefined ? [] : [[value.id, value.limits] as const]))),
      approval: new Map(roles.flatMap(({ value }) => (value.approval === undefined ? [] : [[value.id, toApprovalRule(value.approval)] as const]))),
      notify: new Map(
        roles.flatMap(({ value: { id, notify } }) =>
          notify === undefined ? [] : [[id, { approvalRequests: [...notify.approval_requests], results: [...notify.results] }] as const],
        ),
      ),
      bindings: registry.bindings,
      disabled: registry.disabled,
      codeOperations: registry.codeOperations,
      connectionSettings: new Map([...states].map(([id, s]) => [id, s.settings] as const)),
      pinCheckSeconds: new Map(
        [...connectionById].flatMap(([id, { value: c }]) => (c.adapter === 'mcp' ? [[id, c.pin_check_seconds] as const] : [])),
      ),
      mcpCatalogs,
      connectionTests,
      credentialRefs,
      credentialManagers,
      specChecksSkipped,
      presetChecksSkipped,
      audit: audit?.value.retention_days === undefined ? {} : { retentionDays: audit.value.retention_days },
      auditViewers: new Set(roles.filter(({ value }) => value.view_audit).map(({ value }) => value.id)),
      sensitiveFields: new Set([...registry.all.values()].flatMap((op) => op.located.value.manifest?.sensitive_fields ?? [])),
      changesets: {
        expireAfterHours: changesets?.value.expire_after_hours ?? DEFAULT_EXPIRE_AFTER_HOURS,
        failureThreshold: changesets?.value.failure_threshold ?? DEFAULT_FAILURE_THRESHOLD,
        itemsPerWorkflowRun: changesets?.value.items_per_workflow_run ?? DEFAULT_ITEMS_PER_WORKFLOW_RUN,
        rollbackWindowHours: changesets?.value.rollback_window_hours ?? DEFAULT_ROLLBACK_WINDOW_HOURS,
      },
      hash: hash.digest('hex'),
      sourceFiles: new Map([...sorted, ...specTexts.map(({ file, text }) => ({ file: file.split(sep).join('/'), text }))].map(({ file, text }) => [file, text] as const)),
    },
  };
}

/**
 * Resolver issues carry paths under `openapi.spec` (inside the spec) or
 * `openapi.include`. A preset spec's issues point into the preset file.
 */
/** CONN-8: one connection that binds a preset, with its optional operation prefix. */
interface PresetBinding {
  readonly connection: string;
  readonly prefix?: string;
}

/** The first segment of an operation ID. */
function namespaceOf(operationId: string): string {
  const dot = operationId.indexOf('.');
  return dot < 0 ? operationId : operationId.slice(0, dot);
}

/**
 * The effective namespaces of a binding: its prefix, or the first segments of the preset's own
 * operation IDs. A preset that failed to load has unknown operations, so an unprefixed binding
 * of it gets a sentinel that only another unprefixed binding of the same preset shares.
 */
function bindingNamespaces(binding: PresetBinding, preset: LoadedPreset | undefined): ReadonlySet<string> {
  if (binding.prefix !== undefined) return new Set([binding.prefix]);
  if (preset === undefined) return new Set(['']);
  return new Set(preset.operations.map((o) => namespaceOf(o.id)));
}

/**
 * CONN-8: the operation IDs of a preset bound with `operation_prefix`. `<ns>.<rest>` becomes
 * `<prefix>.<rest>` (a one-segment ID `<id>` becomes `<prefix>.<id>`), and so does every
 * reference to one of the preset's own operations inside its manifests. Other IDs stay as they are.
 */
function presetAlias(preset: LoadedPreset, prefix: string | undefined): { id(operationId: string): string; operation(op: PresetOperationConfig): PresetOperationConfig } {
  const own = new Set(preset.operations.map((o) => o.id));
  const id = (operationId: string): string => {
    if (prefix === undefined || !own.has(operationId)) return operationId;
    const dot = operationId.indexOf('.');
    return `${prefix}.${dot < 0 ? operationId : operationId.slice(dot + 1)}`;
  };
  const operation = (op: PresetOperationConfig): PresetOperationConfig => {
    if (prefix === undefined) return op;
    const m = op.manifest;
    if (m === undefined) return { ...op, id: id(op.id) };
    return {
      ...op,
      id: id(op.id),
      manifest: {
        ...m,
        read_before: { ...m.read_before, operation: id(m.read_before.operation) },
        ...(m.selector === undefined ? {} : { selector: { ...m.selector, operation: id(m.selector.operation) } }),
        rollback: m.rollback.strategy === 'inverse_operation' ? { ...m.rollback, operation: id(m.rollback.operation) } : m.rollback,
      },
    };
  };
  return { id, operation };
}

function locateSpecIssue(state: ConnectionState, issue: SpecIssue, at: (source: SourceDocument, path: readonly PropertyKey[], message: string) => void): void {
  const { located, preset, spec } = state;
  const [head, sub, ...rest] = issue.path;
  const inSpec = head === 'openapi' && sub === 'spec';
  if (inSpec && spec?.kind === 'file' && spec.owner === 'preset' && preset !== undefined) {
    at(preset.source, ['spec', ...rest], issue.message);
    return;
  }
  const relative = head === 'openapi' ? issue.path : ['openapi', 'spec', ...issue.path];
  at(located.source, [...located.path, ...relative], issue.message);
}


function toApprovalRule(approval: RoleApproval): RoleApprovalRule {
  return {
    ...(approval.required === undefined ? {} : { required: approval.required }),
    ...(approval.record_threshold === undefined ? {} : { recordThreshold: approval.record_threshold }),
    steps: (approval.steps ?? []).map((step) => step.role),
    ...(approval.step_up_max_age_seconds === undefined ? {} : { stepUpMaxAgeSeconds: approval.step_up_max_age_seconds }),
    allowWidget: approval.allow_widget,
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
