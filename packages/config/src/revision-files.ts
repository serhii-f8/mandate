/**
 * Configuration revisions as file maps (CFG-4). `revisionFilesOf` collects the files a
 * revision stores; `loadConfigurationFiles` loads such a map through the unchanged
 * directory loader on a private temporary copy, so a revision and its source directory
 * give the same hash.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import type { ConfigRevisionSummary } from '@aiops/core';
import type { ConfigIssue } from './issues.js';
import { loadConfigurationDirectory, type LoadedConfiguration, type LoadOptions, type LoadResult } from './load.js';
import { isSpecUrl } from './upstream-schema.js';

export const MAX_REVISION_PATH = 512;

const INVALID_PATH: ConfigIssue = { file: '.', path: '', message: 'revision holds an invalid file path' };
const OUTSIDE_MESSAGE = 'spec file must be inside the configuration directory to be applied';
const FORBIDDEN_CHARACTER = /[\p{Cc}\\]/u;
const YAML_FILE = /\.ya?ml$/i;

/** A key relative to the revision root, with `/` separators, that cannot leave it. */
export function isRevisionFilePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_REVISION_PATH) return false;
  if (FORBIDDEN_CHARACTER.test(path) || path.startsWith('/')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** The files a revision stores: configuration files and connection-owned local specs. */
export function revisionFilesOf(
  configuration: LoadedConfiguration,
): { readonly ok: true; readonly files: Readonly<Record<string, string>> } | { readonly ok: false; readonly issues: readonly ConfigIssue[] } {
  const keys = [...configuration.sourceFiles.keys()];
  const outside = keys.filter(isOutside);
  if (outside.length > 0) return { ok: false, issues: outsideIssues(configuration, outside) };
  if (!keys.every(isRevisionFilePath)) return { ok: false, issues: [INVALID_PATH] };
  const nul = [...configuration.sourceFiles].filter(([, text]) => text.includes('\u0000'));
  if (nul.length > 0) return { ok: false, issues: nul.map(([file]) => ({ file, path: '', message: 'revision file holds a NUL character' })) };
  return { ok: true, files: Object.fromEntries(configuration.sourceFiles) };
}

/** Entity counts stored with a revision. */
export function revisionSummary(configuration: LoadedConfiguration): ConfigRevisionSummary {
  return {
    connections: configuration.connections.length,
    operations: configuration.policy.operations.length,
    roles: configuration.policy.roles.length,
    notifications: configuration.notifications.length,
  };
}

/**
 * Loads a revision's file map. Every key is checked before anything is written; the files
 * go below a fresh private temporary directory, which is removed whatever the outcome.
 */
export async function loadConfigurationFiles(files: Readonly<Record<string, string>>, options: LoadOptions = {}): Promise<LoadResult> {
  const entries = Object.entries(files);
  if (!validKeys(entries.map(([key]) => key))) return { ok: false, issues: [INVALID_PATH] };
  const dir = await mkdtemp(join(tmpdir(), 'aiops-revision-'));
  try {
    for (const [key, text] of entries) {
      const segments = key.split('/');
      if (segments.length > 1) await mkdir(join(dir, ...segments.slice(0, -1)), { recursive: true, mode: 0o700 });
      await writeFile(join(dir, ...segments), text, { mode: 0o600, flag: 'wx' });
    }
    return await loadConfigurationDirectory(dir, options);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every key valid, and no key is also a directory of another key (it could not be written). */
function validKeys(keys: readonly string[]): boolean {
  if (!keys.every(isRevisionFilePath)) return false;
  const set = new Set(keys);
  return keys.every((key) => {
    const segments = key.split('/');
    for (let i = 1; i < segments.length; i += 1) if (set.has(segments.slice(0, i).join('/'))) return false;
    return true;
  });
}

function isOutside(key: string): boolean {
  return key === '..' || key.startsWith('../') || posix.isAbsolute(key);
}

/**
 * Names the connections whose spec resolves to an outside key (F9). The loaded configuration
 * keeps connection values, not their source file, so a connection matches when its declared
 * path, taken from the directory of any configuration file, gives the key.
 */
function outsideIssues(configuration: LoadedConfiguration, outside: readonly string[]): ConfigIssue[] {
  const yamlFiles = [...configuration.sourceFiles.keys()].filter((key) => YAML_FILE.test(key));
  const local = configuration.connections.flatMap((c) => {
    const declared = c.adapter === 'openapi' ? c.openapi?.spec : undefined;
    return declared === undefined || isSpecUrl(declared) ? [] : [{ id: c.id, declared }];
  });
  const owners = new Set<string>();
  for (const key of outside) {
    const relativeOwners = local.filter(({ declared }) => yamlFiles.some((file) => posix.normalize(posix.join(posix.dirname(file), declared)) === key));
    const matched = relativeOwners.length > 0 ? relativeOwners : local.filter(({ declared }) => posix.isAbsolute(declared));
    for (const { id } of matched) owners.add(id);
  }
  if (owners.size === 0) return [{ file: '.', path: '', message: OUTSIDE_MESSAGE }];
  return [...owners].sort().map((id) => ({ file: '.', path: `connections.${id}.openapi.spec`, message: OUTSIDE_MESSAGE }));
}
