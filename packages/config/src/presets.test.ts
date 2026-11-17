import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePreset } from './presets.js';

const PRESET = fileURLToPath(new URL('../test/fixtures/preset-dir/fake-preset', import.meta.url));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aiops-preset-lookup-'));
  dirs.push(dir);
  return dir;
}

/** Copies the fake preset to `<root>/<name>` with the given package.json version. */
async function install(root: string, name: string, version = '0.1.0', packageName = '@aiops/fake-preset'): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await cp(PRESET, dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: packageName, version }));
  return dir;
}

const ENTRY = { id: 'fake', package: '@aiops/fake-preset' };

describe('CONN-8 preset lookup in preset directories', () => {
  it('takes the first directory that has the package, in the given order', async () => {
    const first = await tempDir();
    const second = await tempDir();
    await install(first, 'a-copy', '1.0.0');
    await install(second, 'b-copy', '2.0.0');
    const result = await resolvePreset(ENTRY, [first, second]);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.preset.version).toBe('1.0.0');
    expect(result.preset.dir).toBe(join(first, 'a-copy'));
    const reversed = await resolvePreset(ENTRY, [second, first]);
    expect(reversed.ok && reversed.preset.version).toBe('2.0.0');
  });

  it('finds packages inside @scope directories', async () => {
    const root = await tempDir();
    await install(root, join('@aiops', 'fake-preset'));
    const result = await resolvePreset(ENTRY, [root]);
    expect(result.ok && result.preset.dir).toBe(join(root, '@aiops', 'fake-preset'));
  });

  it('skips directories with an unparseable or unrelated package.json', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'broken'));
    await writeFile(join(root, 'broken', 'package.json'), '{ not json');
    await install(root, 'other', '0.1.0', '@aiops/other-preset');
    await install(root, 'zz-fake');
    const result = await resolvePreset(ENTRY, [root, '/nonexistent/presets']);
    expect(result.ok && result.preset.dir).toBe(join(root, 'zz-fake'));
  });

  it('reports a missing package and a version mismatch at the entry', async () => {
    const root = await tempDir();
    expect(await resolvePreset(ENTRY, [root])).toEqual({ ok: false, issues: [{ file: '.', path: 'presets.fake.package', message: 'is not installed in the preset directories' }] });
    await install(root, 'fake');
    expect(await resolvePreset({ ...ENTRY, version: '9.9.9' }, [root])).toEqual({
      ok: false,
      issues: [{ file: '.', path: 'presets.fake.version', message: 'does not match the installed package version' }],
    });
  });

  it('names the preset files in its hash inputs by package name', async () => {
    const root = await tempDir();
    await install(root, 'fake');
    const result = await resolvePreset(ENTRY, [root]);
    expect(result.ok && result.preset.files.map((f) => f.file)).toEqual([
      '@aiops/fake-preset/package.json',
      '@aiops/fake-preset/preset.yaml',
      '@aiops/fake-preset/spec.json',
    ]);
  });
});
