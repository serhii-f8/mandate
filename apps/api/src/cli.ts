#!/usr/bin/env node
/**
 * `aiops`: operator commands of the api image (CFG-3, CONN-7, SEC-2).
 *
 *   aiops validate <dir> [--preset-dir <dir>]...   full check: specs resolved, presets loaded
 *   aiops test-connection <connection>             runs the connection's declared test read
 *
 * Exit codes: 0 success, 1 failed or invalid, 2 usage or environment. Each command parses
 * only the environment it needs; errors name variables, never values (SEC-3).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createOpenApiAdapter, type OpenApiAdapter } from '@aiops/adapters';
import { formatIssue, loadConfigurationDirectory, type LoadResult } from '@aiops/config';
import type { AuditLog, CredentialVault } from '@aiops/core';
import { createDb, DrizzleAuditLog, parseMasterKeys, PostgresCredentialVault } from '@aiops/db';
import { ConnectionTestService } from './upstream/connection-test.js';

const USAGE = [
  'usage: aiops validate <dir> [--preset-dir <dir>]...',
  '       aiops test-connection <connection>',
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

export interface CliDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly adapter?: OpenApiAdapter;
  /** Opens the database and vault; the default connects to PostgreSQL (already migrated). */
  readonly openStore?: (input: { databaseUrl: string; masterKeys: string }) => Promise<CliStore>;
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

async function openStoreDefault(input: { databaseUrl: string; masterKeys: string }): Promise<CliStore> {
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
  const audit = new DrizzleAuditLog(database.db);
  return {
    vault,
    audit,
    rotate: (actor, correlationId) => vault.rotate(actor, audit, correlationId),
    close: () => database.close(),
  };
}

async function withStore<T>(deps: CliDeps, env: { DATABASE_URL: string; AIOPS_MASTER_KEYS: string }, action: (store: CliStore) => Promise<T>): Promise<T> {
  let store: CliStore;
  try {
    store = await (deps.openStore ?? openStoreDefault)({ databaseUrl: env.DATABASE_URL, masterKeys: env.AIOPS_MASTER_KEYS });
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
  return withStore(deps, env, async (store) => {
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

export async function runApiCli(argv: readonly string[], out: (line: string) => void, deps: CliDeps = { env: process.env }): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'validate') return await validate(rest, out, deps);
    if (command === 'test-connection') return await testConnection(rest, out, deps);
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
