// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeResolver, fakeCatalogEntry } from '@mandate/testing';
import { loadConfigurationDirectory, type LoadedConfiguration, type LoadOptions, type LoadResult } from './load.js';
import { isRevisionFilePath, loadConfigurationFiles, MAX_REVISION_PATH, revisionFilesOf, revisionSummary } from './revision-files.js';

const FIXTURES = fileURLToPath(new URL('../test/fixtures', import.meta.url));
const VALID_DIR = join(FIXTURES, 'valid');
const DERIVED_DIR = join(FIXTURES, 'derived');

const resolver = (): FakeResolver =>
  new FakeResolver({
    shop: [
      fakeCatalogEntry('shop', { operationId: 'listItems', method: 'GET', path: '/items' }),
      fakeCatalogEntry('shop', { operationId: 'getItem', method: 'GET', path: '/items/{sku}' }),
      fakeCatalogEntry('shop', { operationId: 'deleteItem', method: 'DELETE', path: '/items/{sku}' }),
    ],
  });

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function loaded(result: LoadResult): LoadedConfiguration {
  if (!result.ok) throw new Error(`expected a valid configuration: ${JSON.stringify(result.issues)}`);
  return result.configuration;
}

function filesOf(configuration: LoadedConfiguration): Readonly<Record<string, string>> {
  const result = revisionFilesOf(configuration);
  if (!result.ok) throw new Error(`expected revision files: ${JSON.stringify(result.issues)}`);
  return result.files;
}

/** Runs `fn` with `os.tmpdir()` pointing at a private directory (F8), so parallel tests cannot interfere. */
async function withPrivateTmpdir<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = await tempDir('mandate-revision-test-');
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    return await fn(tmp);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

async function roundTrip(dir: string, options: LoadOptions = {}): Promise<{ readonly direct: LoadedConfiguration; readonly fromFiles: LoadedConfiguration; readonly files: Readonly<Record<string, string>> }> {
  const direct = loaded(await loadConfigurationDirectory(dir, options));
  const files = filesOf(direct);
  const fromFiles = loaded(await loadConfigurationFiles(files, options));
  return { direct, fromFiles, files };
}

describe('CFG-4 revision files', () => {
  it('CFG-4 loading revisionFilesOf a directory gives the same hash as loading the directory', async () => {
    const valid = await roundTrip(VALID_DIR);
    expect(valid.fromFiles.hash).toBe(valid.direct.hash);
    expect(Object.keys(valid.files).sort()).toEqual(['connections.yaml', 'nested/mapping.yaml', 'operations.yaml', 'roles.yaml']);

    const derived = await roundTrip(DERIVED_DIR, { resolver: resolver() });
    expect(derived.fromFiles.hash).toBe(derived.direct.hash);
    expect(Object.keys(derived.files).sort()).toEqual(['config.yaml', 'specs/shop.json']);
  });

  it('CFG-4 spec paths resolve inside the revision, not the working directory', async () => {
    const direct = loaded(await loadConfigurationDirectory(DERIVED_DIR, { resolver: resolver() }));
    const files = filesOf(direct);
    const cwd = await tempDir('mandate-revision-cwd-');
    await mkdir(join(cwd, 'specs'));
    await writeFile(join(cwd, 'specs', 'shop.json'), '{"openapi":"3.0.3","info":{"title":"other","version":"9"},"paths":{}}');
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const fromFiles = loaded(await loadConfigurationFiles(files, { resolver: resolver() }));
      expect(fromFiles.hash).toBe(direct.hash);
    } finally {
      process.chdir(previous);
    }
  });

  it('CFG-4 a hostile file key makes the revision invalid and writes nothing outside the temp directory', async () => {
    const hostile = ['../x.yaml', '/etc/x.yaml', 'a/../../x.yaml', 'a\\b.yaml', 'a\u0000.yaml', 'x'.repeat(MAX_REVISION_PATH + 1), ''];
    await withPrivateTmpdir(async (tmp) => {
      for (const key of hostile) {
        expect(isRevisionFilePath(key)).toBe(false);
        const result = await loadConfigurationFiles({ 'config.yaml': 'version: 1\n', [key]: 'version: 1\n' });
        expect(result).toEqual({ ok: false, issues: [{ file: '.', path: '', message: 'revision holds an invalid file path' }] });
      }
      // `../x.yaml` from a revision directory would land here; keys are checked before mkdtemp, so nothing is created.
      expect(await readdir(tmp)).toEqual([]);
    });
  });

  it('CFG-4 a file key that is also a directory of another key is invalid', async () => {
    await withPrivateTmpdir(async (tmp) => {
      const result = await loadConfigurationFiles({ 'a.yaml': 'version: 1\n', 'a.yaml/b.yaml': 'version: 1\n' });
      expect(result).toEqual({ ok: false, issues: [{ file: '.', path: '', message: 'revision holds an invalid file path' }] });
      expect(await readdir(tmp)).toEqual([]);
    });
  });

  it('CFG-4 isRevisionFilePath accepts relative paths with / separators', () => {
    expect(isRevisionFilePath('config.yaml')).toBe(true);
    expect(isRevisionFilePath('nested/mapping.yaml')).toBe(true);
    expect(isRevisionFilePath('x'.repeat(MAX_REVISION_PATH))).toBe(true);
    for (const bad of ['a//b.yaml', './a.yaml', 'a/./b.yaml', 'a/', 'a\tb.yaml', 'a\u007fb.yaml']) expect(isRevisionFilePath(bad)).toBe(false);
  });

  it('CFG-4 a connection spec outside the directory cannot become a revision', async () => {
    const root = await tempDir('mandate-revision-outside-');
    const dir = join(root, 'conf');
    await cp(DERIVED_DIR, dir, { recursive: true });
    await cp(join(DERIVED_DIR, 'specs', 'shop.json'), join(root, 'outside.json'));
    await writeFile(
      join(dir, 'config.yaml'),
      'version: 1\nconnections:\n  - id: shop\n    adapter: openapi\n    base_url: https://shop.example.test/api\n    openapi: { spec: ../outside.json }\n',
    );
    const configuration = loaded(await loadConfigurationDirectory(dir));
    expect(revisionFilesOf(configuration)).toEqual({
      ok: false,
      issues: [{ file: '.', path: 'connections.shop.openapi.spec', message: 'spec file must be inside the configuration directory to be applied' }],
    });
  });

  it('CFG-4 a file text holding a NUL character cannot become a revision', async () => {
    const root = await tempDir('mandate-revision-nul-');
    await writeFile(join(root, 'config.yaml'), 'version: 1\n# a\u0000b\n');
    const configuration = loaded(await loadConfigurationDirectory(root));
    expect(revisionFilesOf(configuration)).toEqual({ ok: false, issues: [{ file: 'config.yaml', path: '', message: 'revision file holds a NUL character' }] });
  });

  it('CFG-2 an invalid revision returns the issues and removes its temp directory', async () => {
    await withPrivateTmpdir(async (tmp) => {
      const result = await loadConfigurationFiles({ 'roles.yaml': 'version: 1\nroles:\n  - id: Broken\n' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues[0]?.file).toBe('roles.yaml');
      expect(await readdir(tmp)).toEqual([]);
    });
  });

  it('CFG-4 a valid revision also removes its temp directory', async () => {
    const files = filesOf(loaded(await loadConfigurationDirectory(VALID_DIR)));
    await withPrivateTmpdir(async (tmp) => {
      expect((await loadConfigurationFiles(files)).ok).toBe(true);
      expect(await readdir(tmp)).toEqual([]);
    });
  });

  it('CFG-4 revisionSummary counts entities', async () => {
    const configuration = loaded(await loadConfigurationDirectory(VALID_DIR));
    expect(revisionSummary(configuration)).toEqual({
      connections: configuration.connections.length,
      operations: configuration.policy.operations.length,
      roles: configuration.policy.roles.length,
      notifications: configuration.notifications.length,
    });
    expect(revisionSummary(configuration)).toEqual({ connections: 1, operations: 2, roles: 2, notifications: 0 });
  });
});
