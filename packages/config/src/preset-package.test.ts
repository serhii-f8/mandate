import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAiopsField, selectPackage } from './preset-package.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aiops-preset-package-'));
  dirs.push(dir);
  return dir;
}

const NAME = '@acme/aiops-preset-x';

/** Writes `<root>/<sub>/package.json` with the name and version. */
async function pkg(root: string, sub: string, version: string, name = NAME): Promise<string> {
  const dir = join(root, sub);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version }));
  return dir;
}

describe('CONN-8 preset package selection', () => {
  it('CONN-8 picks the highest installed version that satisfies the range across directories', async () => {
    const first = await tempDir();
    const second = await tempDir();
    await pkg(first, 'x-old', '1.1.0');
    await pkg(second, 'x-new', '1.2.0');
    const pick = async (range: string | undefined): Promise<string | undefined> => (await selectPackage(NAME, range, [first, second]))?.version;
    expect(await pick('^1.0.0')).toBe('1.2.0');
    expect(await pick(undefined)).toBe('1.2.0');
    expect(await pick('1.1.0')).toBe('1.1.0');
    expect(await pick('~1.1.0')).toBe('1.1.0');
    expect(await pick('^2.0.0')).toBeUndefined();
    expect((await selectPackage(NAME, '^1.0.0', [first, second]))?.dir).toBe(join(second, 'x-new'));
  });

  it('CONN-8 ignores prereleases and non-semver versions', async () => {
    const root = await tempDir();
    await pkg(root, 'a', '1.3.0-rc.1');
    await pkg(root, 'b', 'banana');
    await pkg(root, 'c', '1.0.5');
    expect((await selectPackage(NAME, '^1.0.0', [root]))?.version).toBe('1.0.5');
    expect((await selectPackage(NAME, undefined, [root]))?.version).toBe('1.0.5');
    await rm(join(root, 'c'), { recursive: true });
    expect(await selectPackage(NAME, '^1.0.0', [root])).toBeUndefined();
  });

  it('CONN-8 equal versions: the first directory wins', async () => {
    const first = await tempDir();
    const second = await tempDir();
    await pkg(first, 'z', '1.0.0');
    await pkg(second, 'a', '1.0.0');
    expect((await selectPackage(NAME, undefined, [first, second]))?.dir).toBe(join(first, 'z'));
    expect((await selectPackage(NAME, '^1.0.0', [second, first]))?.dir).toBe(join(second, 'a'));
  });

  it('CONN-8 finds packages in a node_modules layout with a symlinked package directory', async () => {
    const root = await tempDir();
    const store = await pkg(root, join('store', 'x'), '0.4.0');
    await mkdir(join(root, 'node_modules', '@acme'), { recursive: true });
    await symlink(store, join(root, 'node_modules', '@acme', 'aiops-preset-x'), 'dir');
    // pnpm's hidden store holds a higher version; it is not a candidate.
    await pkg(join(root, 'node_modules', '.pnpm'), 'x', '9.0.0');
    const viaRoot = await selectPackage(NAME, undefined, [root]);
    expect(viaRoot).toMatchObject({ version: '0.4.0', dir: join(root, 'node_modules', '@acme', 'aiops-preset-x') });
    const viaNodeModules = await selectPackage(NAME, undefined, [join(root, 'node_modules')]);
    expect(viaNodeModules?.version).toBe('0.4.0');
  });

  it('CONN-8 parses the aiops field: preset default, sdk required, unknown keys refused', async () => {
    expect(parseAiopsField({ name: 'x', version: '1.0.0' })).toEqual({ ok: true });
    expect(parseAiopsField({ aiops: { sdk: '^0.6.0' } })).toEqual({ ok: true, aiops: { preset: 'preset.yaml', sdk: '^0.6.0' } });
    expect(parseAiopsField({ aiops: { preset: 'presets/main.yaml', sdk: '0.6.x', code: 'dist/index.js' } })).toEqual({
      ok: true,
      aiops: { preset: 'presets/main.yaml', sdk: '0.6.x', code: 'dist/index.js' },
    });
    expect(parseAiopsField({ aiops: {} })).toEqual({ ok: false, issues: [{ path: ['aiops', 'sdk'], message: 'is required' }] });
    expect(parseAiopsField({ aiops: { sdk: 'not a range' } })).toEqual({ ok: false, issues: [{ path: ['aiops', 'sdk'], message: 'must be a semver range' }] });
    const unknown = parseAiopsField({ aiops: { sdk: '^0.6.0', hooks: 'x' } });
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.issues.map((i) => i.path)).toEqual([['aiops']]);
    expect(parseAiopsField({ aiops: 'preset.yaml' }).ok).toBe(false);

    // The candidate carries a valid aiops field.
    const root = await tempDir();
    const dir = join(root, 'x');
    await mkdir(dir);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: NAME, version: '1.0.0', aiops: { sdk: '^0.6.0' } }));
    expect((await selectPackage(NAME, undefined, [root]))?.aiops).toEqual({ preset: 'preset.yaml', sdk: '^0.6.0' });
  });
});
