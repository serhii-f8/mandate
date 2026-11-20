import { appendFile, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { CODE_FIXTURE_PRESET_DIR } from '@aiops/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffConfigurations, formatDiff } from './diff.js';
import { loadConfigurationDirectory, type LoadedConfiguration } from './load.js';
import { loadPresetCode, resetPresetCodeImports } from './preset-code.js';

const PACKAGE = '@aiops/code-fixture-preset';
const CODE = 'lib/index.js';

const dirs: string[] = [];
beforeEach(() => {
  resetPresetCodeImports();
});
afterEach(async () => {
  resetPresetCodeImports();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Copies the code fixture to `<new temp root>/code-fixture` and returns the package directory. */
async function copyFixture(): Promise<string> {
  const dir = join(await tempDir('aiops-preset-code-'), 'code-fixture');
  await cp(CODE_FIXTURE_PRESET_DIR, dir, { recursive: true });
  return dir;
}

const load = (dir: string, code = CODE, importModule?: (url: string) => Promise<unknown>) =>
  loadPresetCode({ packageName: PACKAGE, dir, code, ...(importModule === undefined ? {} : { importModule }) });

const issue = (message: string) => ({ ok: false, issues: [{ file: `${PACKAGE}/package.json`, path: 'aiops.code', message }] });

/**
 * Imports a module with Node's own loader in a worker thread, as production does: Vitest's
 * module runner resolves bare specifiers from the workspace and reports syntax errors its own
 * way (F23). The worker reports failures only; a successful import answers an empty namespace.
 */
function nativeImport(url: string): Promise<unknown> {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData).then(
      () => parentPort.postMessage({ ok: true }),
      (e) => parentPort.postMessage({ ok: false, code: e && typeof e.code === 'string' ? e.code : undefined, message: String(e && e.message) }),
    );`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: url });
    worker.once('message', (m: { ok: boolean; code?: string; message?: string }) => {
      void worker.terminate();
      if (m.ok) resolve({});
      else reject(Object.assign(new Error(m.message), m.code === undefined ? {} : { code: m.code }));
    });
    worker.once('error', reject);
  });
}

/** The fixture preset with its HTTP read only (F6: code and record bindings load from T4/T6 on). */
const REDUCED_PRESET = `version: 1
adapter: openapi
spec: spec/fixture.json
auth: { scheme: bearer }
operations:
  - id: fixture.search
    risk: read
    description: List items.
    input_schema:
      type: object
      properties:
        page: { type: integer, minimum: 1 }
        per_page: { type: integer, minimum: 1, maximum: 100 }
        fields: { type: array, items: { type: string } }
      required: [page, per_page, fields]
      additionalProperties: false
    fields_arg: fields
    upstream:
      method: GET
      path: /items
      query: { page: { arg: page }, limit: { arg: per_page } }
      response: { items: items, fields_from_arg: fields }
`;

const CONFIG = `version: 1
presets:
  - { id: fixture, package: "${PACKAGE}" }
connections:
  - id: items
    adapter: openapi
    base_url: https://items.example.test/api
    credential_ref: items-token
    preset: fixture
roles:
  - id: viewer
    grants:
      - { operation: fixture.search }
  - id: integration_admin
    grants: []
    manage_credentials: [items-token]
role_mapping:
  - { group: viewers, roles: [viewer] }
`;

describe('OPS-5 CONN-8 preset code modules', () => {
  it('OPS-5 loads the fixture code module and exposes its operations', async () => {
    const dir = await copyFixture();
    const result = await load(dir);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const { operations } = result.code.module;
    expect(Object.fromEntries(Object.entries(operations).map(([name, op]) => [name, op.kind]))).toEqual({
      get_many: 'read',
      set_tags: 'write',
      ping: 'call',
      boom: 'read',
    });
    expect(result.code.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.code.entry.endsWith(join('code-fixture', 'lib', 'index.js'))).toBe(true);
  });

  it('CFG-4 the digest changes when any file of the code tree changes, and not when a file outside it does', async () => {
    const dir = await copyFixture();
    const digest = async (): Promise<string> => {
      resetPresetCodeImports();
      const result = await load(dir);
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      return result.code.digest;
    };
    const first = await digest();
    expect(await digest()).toBe(first);
    await appendFile(join(dir, 'preset.yaml'), '# outside the code tree\n');
    await writeFile(join(dir, 'README.md'), 'outside');
    expect(await digest()).toBe(first);
    await mkdir(join(dir, 'lib', 'nested'));
    await writeFile(join(dir, 'lib', 'nested', 'helper.js'), 'export const x = 1;\n');
    const withHelper = await digest();
    expect(withHelper).not.toBe(first);
    await writeFile(join(dir, 'lib', 'nested', 'helper.js'), 'export const x = 2;\n');
    expect(await digest()).not.toBe(withHelper);
  });

  it('CFG-4 the configuration hash differs for two copies whose dist differs by one byte', async () => {
    const hashOf = async (edit?: (dir: string) => Promise<void>): Promise<LoadedConfiguration> => {
      const presets = await tempDir('aiops-preset-code-presets-');
      const dir = join(presets, 'code-fixture');
      await cp(CODE_FIXTURE_PRESET_DIR, dir, { recursive: true });
      await writeFile(join(dir, 'preset.yaml'), REDUCED_PRESET);
      await edit?.(dir);
      const config = await tempDir('aiops-preset-code-config-');
      await writeFile(join(config, 'config.yaml'), CONFIG);
      const result = await loadConfigurationDirectory(config, { presetDirs: [presets] });
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      return result.configuration;
    };
    const a = await hashOf();
    const b = await hashOf();
    const c = await hashOf((dir) => appendFile(join(dir, CODE), ' '));
    const digestOf = (config: LoadedConfiguration): string | undefined => config.loadedPresets.get('fixture')?.codeDigest;
    expect(digestOf(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(digestOf(b)).toBe(digestOf(a));
    expect(b.hash).toBe(a.hash);
    expect(digestOf(c)).not.toBe(digestOf(a));
    expect(c.hash).not.toBe(a.hash);
    // CFG-3: `config diff` sees the code change as a change of the preset's files.
    expect(formatDiff(diffConfigurations(a, c))[0]).toBe('~ preset fixture: files');
  });

  it('OPS-5 a code path at the package root or outside the package is refused', async () => {
    const dir = await copyFixture();
    const placement = issue('must be a path inside a subdirectory of the preset');
    await writeFile(join(dir, 'root.js'), 'export default { operations: {} };\n');
    expect(await load(dir, 'root.js')).toEqual(placement);
    expect(await load(dir, './root.js')).toEqual(placement);
    expect(await load(dir, '../outside/index.js')).toEqual(placement);
    expect(await load(dir, join(dir, CODE))).toEqual(placement);
    // A subdirectory that is a link to the package root is the root.
    await symlink('.', join(dir, 'self'));
    expect(await load(dir, 'self/root.js')).toEqual(placement);
  });

  it('OPS-5 a symlink in the code tree that points outside the preset is refused', async () => {
    const dir = await copyFixture();
    const elsewhere = await tempDir('aiops-preset-code-elsewhere-');
    await writeFile(join(elsewhere, 'secret.js'), 'export const s = 1;\n');
    await symlink(join(elsewhere, 'secret.js'), join(dir, 'lib', 'secret.js'));
    expect(await load(dir)).toEqual(issue('code directory links outside the preset'));

    // A link that stays inside the package is part of the tree.
    const inside = await copyFixture();
    await symlink(join(inside, 'preset.yaml'), join(inside, 'lib', 'preset-link.yaml'));
    expect((await load(inside)).ok).toBe(true);
  });

  it('OPS-5 a code tree over 2000 files is refused', async () => {
    const dir = await copyFixture();
    await mkdir(join(dir, 'lib', 'node_modules'));
    // index.js plus 2000 more files.
    await Promise.all(Array.from({ length: 2000 }, (_, i) => writeFile(join(dir, 'lib', 'node_modules', `f${i}.js`), '')));
    expect(await load(dir)).toEqual(issue('code directory exceeds 2000 files or 20 MiB'));

    const big = await copyFixture();
    await writeFile(join(big, 'lib', 'big.bin'), Buffer.alloc(20 * 1024 * 1024));
    expect(await load(big)).toEqual(issue('code directory exceeds 2000 files or 20 MiB'));
  });

  it('OPS-5 an import failure reports the error code only', async () => {
    const syntax = await copyFixture();
    await writeFile(join(syntax, CODE), 'export default {{{\n');
    const syntaxResult = await load(syntax, CODE, nativeImport);
    expect(syntaxResult).toEqual(issue('cannot be imported (unknown)'));
    // Vitest's module runner throws its own error without an ERR_ code: the same answer.
    resetPresetCodeImports();
    expect(await load(syntax)).toEqual(issue('cannot be imported (unknown)'));

    const missing = await copyFixture();
    await writeFile(join(missing, CODE), "import { CONNECTOR_SDK_VERSION } from '@aiops/connector-sdk';\nexport default { operations: {}, v: CONNECTOR_SDK_VERSION };\n");
    const missingResult = await load(missing, CODE, nativeImport);
    expect(missingResult).toEqual(issue('cannot be imported (ERR_MODULE_NOT_FOUND)'));

    const hostile = await copyFixture();
    const thrower = async (): Promise<unknown> => {
      await Promise.resolve();
      throw Object.assign(new Error(`failed at ${hostile}`), { code: `ERR_${'X'.repeat(61)}` });
    };
    expect(await load(hostile, CODE, thrower)).toEqual(issue('cannot be imported (unknown)'));

    for (const result of [syntaxResult, missingResult]) {
      expect(JSON.stringify(result)).not.toContain(tmpdir());
    }
  });

  it('OPS-5 a default export that is not a preset module is refused', async () => {
    const cases: [string, string][] = [
      ['export default 42;\n', 'default export is not a preset module: operations must be an object'],
      ['export const operations = {};\n', 'default export is not a preset module: operations must be an object'],
      ["export default { operations: { GetMany: { kind: 'read', read: async () => ({ items: [] }) } } };\n", 'default export is not a preset module: operation name GetMany is invalid'],
      [
        "export default { get operations() { throw new Error('getter failed /secret/path'); } };\n",
        'default export is not a preset module: the export threw when it was read',
      ],
    ];
    for (const [source, message] of cases) {
      const dir = await copyFixture();
      await writeFile(join(dir, CODE), source);
      expect(await load(dir)).toEqual(issue(message));
    }
    const hostile = await copyFixture();
    const namespaceThrows = (): Promise<unknown> =>
      Promise.resolve({
        get default(): unknown {
          throw new Error('namespace getter failed');
        },
      });
    expect(await load(hostile, CODE, namespaceThrows)).toEqual(issue('default export is not a preset module: the export threw when it was read'));
  });

  it('OPS-5 the same entry with a changed tree in one process is refused until restart', async () => {
    const dir = await copyFixture();
    expect((await load(dir)).ok).toBe(true);
    // The same tree again: the same import, no issue.
    expect((await load(dir)).ok).toBe(true);
    await writeFile(join(dir, 'lib', 'extra.js'), 'export const extra = 1;\n');
    expect(await load(dir)).toEqual(issue('preset code changed since this process loaded it; restart the process'));
    // Restoring the tree loads again.
    await rm(join(dir, 'lib', 'extra.js'));
    expect((await load(dir)).ok).toBe(true);
    // A restart forgets the record.
    await writeFile(join(dir, 'lib', 'extra.js'), 'export const extra = 1;\n');
    resetPresetCodeImports();
    expect((await load(dir)).ok).toBe(true);
  });
});
