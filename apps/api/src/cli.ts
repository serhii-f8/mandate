#!/usr/bin/env node
/**
 * `aiops`: operator commands of the api image (CFG-3, CONN-7, SEC-2).
 *
 *   aiops validate <dir> [--preset-dir <dir>]...   full check: specs resolved, presets loaded
 *   aiops test-connection <connection>             runs the connection's declared test read
 *   aiops credentials rotate                       re-wraps credential data keys under the newest master key
 *   aiops audit verify [--archive <file>]          checks the audit hash chain, or one retention archive (AUD-5)
 *   aiops audit retention --now                    runs the audit retention job once (AUD-7)
 *   aiops config diff <dir> [--preset-dir <dir>]...                 compares <dir> with the active revision (CFG-3)
 *   aiops config apply <dir> [--preset-dir <dir>]... [--actor <n>]  stores <dir> as the new active revision (CFG-3, CFG-4)
 *
 * Exit codes: 0 success, 1 failed or invalid, 2 usage or environment. Each command parses
 * only the environment it needs; errors name variables, never values (SEC-3).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createOpenApiAdapter, type OpenApiAdapter } from '@aiops/adapters';
import {
  diffConfigurations,
  diffCounts,
  formatDiff,
  formatIssue,
  loadConfigurationDirectory,
  loadConfigurationFiles,
  revisionFilesOf,
  revisionSummary,
  type LoadedConfiguration,
  type LoadOptions,
  type LoadResult,
} from '@aiops/config';
import type { AuditLog, ConfigRevision, ConfigRevisionStore, CredentialVault } from '@aiops/core';
import {
  createDb,
  type Db,
  DrizzleAuditLog,
  formatArchiveReport,
  formatVerifyReport,
  parseMasterKeys,
  PostgresConfigRevisionStore,
  PostgresCredentialVault,
  PostgresRateCounter,
  runAuditRetention,
  verifyAuditArchive,
  verifyAuditChain,
} from '@aiops/db';
import type pg from 'pg';
import { ConnectionTestService } from './upstream/connection-test.js';

const USAGE = [
  'usage: aiops validate <dir> [--preset-dir <dir>]...',
  '       aiops test-connection <connection>',
  '       aiops credentials rotate',
  '       aiops audit verify [--archive <file>]',
  '       aiops audit retention --now',
  '       aiops config diff <dir> [--preset-dir <dir>]...',
  '       aiops config apply <dir> [--preset-dir <dir>]... [--actor <name>]',
].join('\n');

/** The actor and client the CLI audits as. */
const CLI_ACTOR = 'cli';
const PRESETS_NOT_SET = 'preset directories not set: pass --preset-dir or set AIOPS_PRESET_DIRS';

/** What a database-backed command needs. `close` ends the connection pool. */
export interface CliStore {
  readonly vault: CredentialVault;
  readonly audit: AuditLog;
  rotate(actor: string, correlationId: string): Promise<{ rewrapped: number; onOldVersions: number; failed: readonly string[] }>;
  close(): Promise<void>;
}

export interface StoreInput {
  readonly databaseUrl: string;
  readonly masterKeys: string;
  /** The loaded configuration's `sensitive_fields` for the store's audit log (AUD-4); absent when the command loads none. */
  readonly sensitiveKeys?: ReadonlySet<string>;
}

export interface CliDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly adapter?: OpenApiAdapter;
  /** Opens the database and vault; the default connects to PostgreSQL (already migrated). */
  readonly openStore?: (input: StoreInput) => Promise<CliStore>;
  /** Opens the database for the audit commands; the default connects to PostgreSQL (already migrated). */
  readonly openPool?: (databaseUrl: string) => Promise<{ pool: pg.Pool; db: Db; close(): Promise<void> }>;
  /** Opens the configuration revision store for `config diff` and `config apply`; the default connects to PostgreSQL (already migrated). */
  readonly openConfigStore?: (input: { databaseUrl: string }) => Promise<{ store: ConfigRevisionStore; close(): Promise<void> }>;
  readonly newId?: () => string;
  /** Preset directory used when none is given and presets are declared; `null` for none. Defaults to `presets/` of the repository, when it exists next to the package. */
  readonly defaultPresetDir?: string | null;
}

/** An error whose message is safe to print (names and fixed reasons only). */
class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2,
  ) {
    super(message);
  }
}

const postgresUrl = z.string().refine((v) => /^postgres(ql)?:\/\/./.test(v), { message: 'must be a postgres:// or postgresql:// URL' });
const nonEmpty = z.string().trim().min(1);

/** Parses only the variables a command needs; the reason never quotes the value. */
function parseEnv<S extends z.ZodRawShape>(shape: S, env: Readonly<Record<string, string | undefined>>): z.output<z.ZodObject<S>> {
  const result = z.object(shape).safeParse(env);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    const name = String(issue.path[0] ?? 'environment');
    const reason = env[name] === undefined ? 'is required' : issue.code === 'custom' ? issue.message : 'is invalid';
    return `${name}: ${reason}`;
  });
  throw new CliError(`Invalid environment: ${problems.join('; ')}`, 2);
}

function defaultRepositoryPresets(): string | undefined {
  // dist/cli.js and src/cli.ts both sit three levels below the repository root.
  const dir = fileURLToPath(new URL('../../../presets', import.meta.url));
  return existsSync(dir) ? dir : undefined;
}

function presetDirsOf(flagged: readonly string[], env: Readonly<Record<string, string | undefined>>, deps: CliDeps): string[] | undefined {
  if (flagged.length > 0) return [...flagged];
  const fromEnv = (env.AIOPS_PRESET_DIRS ?? '').split(':').map((d) => d.trim()).filter((d) => d.length > 0);
  if (fromEnv.length > 0) return fromEnv;
  const fallback = deps.defaultPresetDir === undefined ? defaultRepositoryPresets() : (deps.defaultPresetDir ?? undefined);
  return fallback === undefined ? undefined : [fallback];
}

/** Loads with the adapter's resolver and the preset directories; reports issues and unchecked presets. */
async function loadChecked(
  dir: string,
  presetDirs: string[] | undefined,
  adapter: OpenApiAdapter,
  out: (line: string) => void,
): Promise<Extract<LoadResult, { ok: true }>['configuration'] | undefined> {
  const result = await loadConfigurationDirectory(dir, { resolver: adapter.resolver, ...(presetDirs === undefined ? {} : { presetDirs }) });
  if (!result.ok) {
    for (const issue of result.issues) out(formatIssue(issue));
    out(`Configuration invalid: ${String(result.issues.length)} issue${result.issues.length === 1 ? '' : 's'}`);
    return undefined;
  }
  if (result.configuration.presetChecksSkipped) {
    out(PRESETS_NOT_SET);
    return undefined;
  }
  return result.configuration;
}

function parseValidateArgs(args: readonly string[]): { dir: string; presetDirs: string[] } | undefined {
  const [dir, ...rest] = args;
  if (dir === undefined || dir.startsWith('--')) return undefined;
  const presetDirs: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (rest[i] !== '--preset-dir' || value === undefined || value === '') return undefined;
    presetDirs.push(value);
  }
  return { dir, presetDirs };
}

async function validate(args: readonly string[], out: (line: string) => void, deps: CliDeps): Promise<number> {
  const parsed = parseValidateArgs(args);
  if (parsed === undefined) {
    out(USAGE);
    return 2;
  }
  const configuration = await loadChecked(parsed.dir, presetDirsOf(parsed.presetDirs, deps.env, deps), deps.adapter ?? createOpenApiAdapter(), out);
  if (configuration === undefined) return 1;
  const { policy, connections } = configuration;
  out(`Configuration valid: ${String(connections.length)} connections, ${String(policy.operations.length)} operations, ${String(policy.roles.length)} roles`);
  return 0;
}

async function openStoreDefault(input: StoreInput): Promise<CliStore> {
  const keys = parseMasterKeys(input.masterKeys);
  const database = createDb(input.databaseUrl, { onError: () => undefined });
  try {
    // The CLI never migrates: the api does that on start (NFR-5).
    await database.pool.query('SELECT 1 FROM credential LIMIT 1');
  } catch {
    await database.close();
    throw new CliError('cannot read the credential table: check DATABASE_URL, and start the api once so it applies the migrations', 1);
  }
  const vault = new PostgresCredentialVault(database.db, keys);
  const { sensitiveKeys } = input;
  const audit = new DrizzleAuditLog(database.db, sensitiveKeys === undefined ? {} : { sensitiveKeys: () => sensitiveKeys });
  return {
    vault,
    audit,
    rotate: (actor, correlationId) => vault.rotate(actor, correlationId),
    close: () => database.close(),
  };
}

async function withStore<T>(
  deps: CliDeps,
  env: { DATABASE_URL: string; AIOPS_MASTER_KEYS: string },
  sensitiveKeys: ReadonlySet<string> | undefined,
  action: (store: CliStore) => Promise<T>,
): Promise<T> {
  let store: CliStore;
  try {
    const input = { databaseUrl: env.DATABASE_URL, masterKeys: env.AIOPS_MASTER_KEYS };
    store = await (deps.openStore ?? openStoreDefault)(sensitiveKeys === undefined ? input : { ...input, sensitiveKeys });
  } catch (error) {
    if (error instanceof CliError) throw error;
    // parseMasterKeys errors carry the variable and an entry index only; anything else is unexpected.
    if (error instanceof Error && error.message.startsWith('AIOPS_MASTER_KEYS: ')) throw new CliError(error.message, 2);
    throw new CliError('cannot open the database', 1);
  }
  try {
    return await action(store);
  } finally {
    await store.close();
  }
}

/** Opens the audit commands' database; any failure is a fixed message (SEC-3). */
async function withPool<T>(deps: CliDeps, databaseUrl: string, action: (database: { pool: pg.Pool; db: Db }) => Promise<T>): Promise<T> {
  let database: Awaited<ReturnType<NonNullable<CliDeps['openPool']>>>;
  try {
    database = await (deps.openPool ?? ((url) => Promise.resolve(createDb(url, { onError: () => undefined }))))(databaseUrl);
  } catch {
    throw new CliError('cannot open the database', 1);
  }
  try {
    return await action(database);
  } finally {
    await database.close();
  }
}

type AuditArgs = { kind: 'verify'; archive: string | undefined } | { kind: 'retention' };

function parseAuditArgs(args: readonly string[]): AuditArgs | undefined {
  const [sub, ...rest] = args;
  if (sub === 'verify') {
    if (rest.length === 0) return { kind: 'verify', archive: undefined };
    const [flag, file, ...extra] = rest;
    if (flag !== '--archive' || file === undefined || file === '' || extra.length > 0) return undefined;
    return { kind: 'verify', archive: file };
  }
  if (sub === 'retention' && rest.length === 1 && rest[0] === '--now') return { kind: 'retention' };
  return undefined;
}

async function audit(args: readonly string[], out: (line: string) => void, deps: CliDeps): Promise<number> {
  const parsed = parseAuditArgs(args);
  if (parsed === undefined) {
    out(USAGE);
    return 2;
  }
  if (parsed.kind === 'verify') {
    const env = parseEnv({ DATABASE_URL: postgresUrl }, deps.env);
    return withPool(deps, env.DATABASE_URL, async ({ pool }) => {
      try {
        const { archive } = parsed;
        if (archive === undefined) {
          const report = await verifyAuditChain(pool);
          out(formatVerifyReport(report));
          return report.ok ? 0 : 1;
        }
        const report = await verifyAuditArchive(pool, archive);
        out(formatArchiveReport(report));
        return report.ok ? 0 : 1;
      } catch {
        // Verification can throw on tampered columns; the message must carry no row content (SEC-3).
        out('audit verification could not run');
        return 1;
      }
    });
  }
  const env = parseEnv(
    {
      AIOPS_CONFIG_DIR: nonEmpty,
      DATABASE_URL: postgresUrl,
      AIOPS_AUDIT_ARCHIVE_DIR: z.string().startsWith('/', { message: 'must be an absolute path' }).optional(),
    },
    deps.env,
  );
  const configuration = await loadChecked(env.AIOPS_CONFIG_DIR, presetDirsOf([], deps.env, deps), deps.adapter ?? createOpenApiAdapter(), out);
  if (configuration === undefined) return 1;
  const sensitiveKeys = configuration.sensitiveFields;
  return withPool(deps, env.DATABASE_URL, async ({ pool, db }) => {
    const newId = deps.newId ?? randomUUID;
    const report = await runAuditRetention({
      pool,
      audit: new DrizzleAuditLog(db, { sensitiveKeys: () => sensitiveKeys }),
      rateCounter: new PostgresRateCounter(db),
      retentionDays: configuration.audit.retentionDays,
      archiveDir: env.AIOPS_AUDIT_ARCHIVE_DIR,
      actor: CLI_ACTOR,
      now: () => new Date(),
      newId,
    });
    // `locked` writes no audit row and has no logger here: the printed line is the log (ruling T8/F16, R6).
    switch (report.kind) {
      case 'archived':
        out(`archived first=${String(report.first)} last=${String(report.last)} count=${String(report.count)} archive=${report.archive}`);
        return 0;
      case 'nothing_due':
        out('nothing due');
        return 0;
      case 'not_configured':
        out('nothing due (audit.retention_days is not set)');
        return 0;
      case 'refused':
        out(`refused reason=${report.reason}`);
        return 1;
      case 'locked':
        out('refused reason=locked');
        return 1;
    }
  });
}

async function testConnection(args: readonly string[], out: (line: string) => void, deps: CliDeps): Promise<number> {
  const [connectionId, ...extra] = args;
  if (connectionId === undefined || extra.length > 0) {
    out(USAGE);
    return 2;
  }
  const env = parseEnv({ AIOPS_CONFIG_DIR: nonEmpty, DATABASE_URL: postgresUrl, AIOPS_MASTER_KEYS: nonEmpty }, deps.env);
  const adapter = deps.adapter ?? createOpenApiAdapter();
  const configuration = await loadChecked(env.AIOPS_CONFIG_DIR, presetDirsOf([], deps.env, deps), adapter, out);
  if (configuration === undefined) return 1;
  return withStore(deps, env, configuration.sensitiveFields, async (store) => {
    const newId = deps.newId ?? randomUUID;
    const service = new ConnectionTestService({ configuration: () => configuration, vault: store.vault, adapter, audit: store.audit, newId });
    const report = await service.run(connectionId, CLI_ACTOR, CLI_ACTOR, newId());
    const scopes = report.scopes.detectable ? `detectable:${report.scopes.values.join(',')}` : 'not detectable';
    if (report.ok) {
      out(`ok status=${String(report.status ?? 0)} items=${String(report.itemCount ?? 0)} ms=${String(report.durationMs)} scopes=${scopes}`);
      return 0;
    }
    out(`failed code=${report.code ?? 'unknown'}${report.status === undefined ? '' : ` status=${String(report.status)}`} message=${report.message ?? ''}`);
    return 1;
  });
}

async function rotate(args: readonly string[], out: (line: string) => void, deps: CliDeps): Promise<number> {
  if (args.length > 0) {
    out(USAGE);
    return 2;
  }
  const env = parseEnv({ DATABASE_URL: postgresUrl, AIOPS_MASTER_KEYS: nonEmpty }, deps.env);
  return withStore(deps, env, undefined, async (store) => {
    const result = await store.rotate(CLI_ACTOR, (deps.newId ?? randomUUID)());
    out(`rewrapped=${String(result.rewrapped)} on_old_versions=${String(result.onOldVersions)}`);
    // Refs are identifiers, not secrets. A row that cannot be opened with the configured keys needs the operator.
    for (const ref of result.failed) out(`unreadable credential: ${ref}`);
    return result.failed.length > 0 ? 1 : 0;
  });
}

/** `--actor` and `$USER` values usable in the actor `cli:<name>` (CFG-4). */
const ACTOR_NAME = /^[A-Za-z0-9._@-]{1,64}$/;
const CONCURRENT_APPLY = 'concurrent_apply: another revision was applied meanwhile; run diff again';

async function openConfigStoreDefault(input: { databaseUrl: string }): Promise<{ store: ConfigRevisionStore; close(): Promise<void> }> {
  const database = createDb(input.databaseUrl, { onError: () => undefined });
  try {
    // The CLI never migrates: the api does that on start (NFR-5).
    await database.pool.query('SELECT 1 FROM config_revision LIMIT 1');
  } catch {
    await database.close();
    throw new CliError('cannot read the config_revision table: check DATABASE_URL, and start the api once so it applies the migrations', 1);
  }
  return { store: new PostgresConfigRevisionStore(database.db, { databaseUrl: input.databaseUrl }), close: () => database.close() };
}

/** Opens the revision store; any failure other than a CliError is a fixed message (SEC-3). */
async function withConfigStore<T>(deps: CliDeps, databaseUrl: string, action: (store: ConfigRevisionStore) => Promise<T>): Promise<T> {
  let opened: Awaited<ReturnType<NonNullable<CliDeps['openConfigStore']>>>;
  try {
    opened = await (deps.openConfigStore ?? openConfigStoreDefault)({ databaseUrl });
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('cannot open the database', 1);
  }
  try {
    return await action(opened.store);
  } finally {
    await opened.close();
  }
}

interface ConfigArgs {
  readonly dir: string;
  readonly presetDirs: string[];
  readonly actor: string | undefined;
}

/** `<dir> [--preset-dir <dir>]...`, plus `[--actor <name>]` for apply; undefined is a usage error. */
function parseConfigArgs(args: readonly string[], allowActor: boolean): ConfigArgs | undefined {
  const [dir, ...rest] = args;
  if (dir === undefined || dir.startsWith('--')) return undefined;
  const presetDirs: string[] = [];
  let actor: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) return undefined;
    if (flag === '--preset-dir' && value !== '') presetDirs.push(value);
    else if (flag === '--actor' && allowActor && actor === undefined) {
      // The value is not printed: it is operator input of unknown content.
      if (!ACTOR_NAME.test(value)) throw new CliError('--actor: must be 1 to 64 characters of A-Z a-z 0-9 . _ @ -', 2);
      actor = value;
    } else return undefined;
  }
  return { dir, presetDirs, actor };
}

/** `cli:<name>` from `--actor`, else `cli:$USER` when usable, else `cli` (CFG-4). */
function applyActor(flagged: string | undefined, env: Readonly<Record<string, string | undefined>>): string {
  if (flagged !== undefined) return `${CLI_ACTOR}:${flagged}`;
  const user = env.USER;
  return user !== undefined && ACTOR_NAME.test(user) ? `${CLI_ACTOR}:${user}` : CLI_ACTOR;
}

/**
 * Loads the active revision with the options `<dir>` was loaded with. One that cannot be
 * loaded on this machine (invalid, another hash, or not writable locally) is reported and
 * compared as absent, so every entity shows as added.
 */
async function loadActive(active: ConfigRevision | undefined, options: LoadOptions, out: (line: string) => void): Promise<LoadedConfiguration | undefined> {
  if (active === undefined) return undefined;
  let code: 'invalid' | 'configuration_mismatch' | 'unavailable';
  try {
    const result = await loadConfigurationFiles(active.files, options);
    if (result.ok && result.configuration.hash === active.hash) return result.configuration;
    code = result.ok ? 'configuration_mismatch' : 'invalid';
  } catch {
    code = 'unavailable';
  }
  out(`active revision ${active.id} cannot be loaded here (${code}); every entity is shown as added`);
  return undefined;
}

/** `aiops config diff` and `aiops config apply` (CFG-3, CFG-4). */
async function configChange(kind: 'diff' | 'apply', args: readonly string[], out: (line: string) => void, deps: CliDeps): Promise<number> {
  const parsed = parseConfigArgs(args, kind === 'apply');
  if (parsed === undefined) {
    out(USAGE);
    return 2;
  }
  const env = parseEnv({ DATABASE_URL: postgresUrl }, deps.env);
  const actor = applyActor(parsed.actor, deps.env);
  const adapter = deps.adapter ?? createOpenApiAdapter();
  const presetDirs = presetDirsOf(parsed.presetDirs, deps.env, deps);
  const configuration = await loadChecked(parsed.dir, presetDirs, adapter, out);
  if (configuration === undefined) return 1;
  let files: Readonly<Record<string, string>> = {};
  if (kind === 'apply') {
    const collected = revisionFilesOf(configuration);
    if (!collected.ok) {
      for (const issue of collected.issues) out(formatIssue(issue));
      return 1;
    }
    files = collected.files;
  }
  const options: LoadOptions = { resolver: adapter.resolver, ...(presetDirs === undefined ? {} : { presetDirs }) };
  return withConfigStore(deps, env.DATABASE_URL, async (store) => {
    const active = await store.active();
    const before = await loadActive(active, options, out);
    // The stored hash, also when the active revision could not be loaded here: apply commits only if it is still active.
    const diff = { ...diffConfigurations(before, configuration), previousHash: active?.hash ?? null };
    for (const line of formatDiff(diff)) out(line);
    if (kind === 'diff' || diff.previousHash === diff.hash) return 0;

    const newId = deps.newId ?? randomUUID;
    const revision = newId();
    const result = await store.apply(
      { id: revision, hash: configuration.hash, files, actor, summary: revisionSummary(configuration) },
      {
        id: newId(),
        actor,
        clientId: CLI_ACTOR,
        action: 'config.apply',
        outcome: 'ok',
        correlationId: newId(),
        details: { revision, hash: configuration.hash, previousHash: diff.previousHash, ...diffCounts(diff) },
      },
      diff.previousHash,
    );
    if (result.ok) {
      out(`applied revision ${result.revision.id} (seq ${String(result.revision.seq)})`);
      return 0;
    }
    if (result.reason === 'unchanged') {
      out('No changes');
      return 0;
    }
    out(CONCURRENT_APPLY);
    return 1;
  });
}

export async function runApiCli(argv: readonly string[], out: (line: string) => void, deps: CliDeps = { env: process.env }): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'validate') return await validate(rest, out, deps);
    if (command === 'test-connection') return await testConnection(rest, out, deps);
    if (command === 'credentials' && rest[0] === 'rotate') return await rotate(rest.slice(1), out, deps);
    if (command === 'audit') return await audit(rest, out, deps);
    if (command === 'config' && (rest[0] === 'diff' || rest[0] === 'apply')) return await configChange(rest[0], rest.slice(1), out, deps);
    out(USAGE);
    return 2;
  } catch (error) {
    // Only CliError messages are known to be value-free (SEC-3); anything else prints a fixed text.
    if (error instanceof CliError) {
      out(error.message);
      return error.exitCode;
    }
    out('the command failed unexpectedly');
    return 1;
  }
}

function isEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  process.exitCode = await runApiCli(process.argv.slice(2), (line) => {
    console.log(line);
  });
}
