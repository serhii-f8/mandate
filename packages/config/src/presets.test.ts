import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

/** Copies the fake preset to `<root>/<name>` with the given package.json version (and extra package.json fields). */
async function install(root: string, name: string, version = '0.1.0', packageName = '@aiops/fake-preset', extra: Record<string, unknown> = {}): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await cp(PRESET, dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: packageName, version, ...extra }));
  return dir;
}

/** Installs the fake preset with an `aiops` field. */
async function installWithAiops(aiops: unknown): Promise<string> {
  return install(await tempDir(), 'fake', '0.1.0', '@aiops/fake-preset', { aiops });
}

const ENTRY = { id: 'fake', package: '@aiops/fake-preset' };

describe('CONN-8 preset lookup in preset directories', () => {
  it('takes the first directory that has the package, in the given order, on equal versions', async () => {
    const first = await tempDir();
    const second = await tempDir();
    await install(first, 'a-copy', '1.0.0');
    await install(second, 'b-copy', '1.0.0');
    const result = await resolvePreset(ENTRY, [first, second]);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.preset.version).toBe('1.0.0');
    expect(result.preset.dir).toBe(join(first, 'a-copy'));
    const reversed = await resolvePreset(ENTRY, [second, first]);
    expect(reversed.ok && reversed.preset.dir).toBe(join(second, 'b-copy'));
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

  it('CONN-8 NFR-18 a preset whose sdk range the platform does not satisfy is refused with preset_sdk_incompatible', async () => {
    const root = await installWithAiops({ sdk: '^2.0.0' });
    expect(await resolvePreset(ENTRY, [join(root, '..')])).toEqual({
      ok: false,
      issues: [
        {
          file: '@aiops/fake-preset/package.json',
          path: 'aiops.sdk',
          message: 'preset_sdk_incompatible: the preset requires connector SDK ^2.0.0; this platform provides 1.0.0',
        },
      ],
    });
    const compatible = await resolvePreset(ENTRY, [join(await installWithAiops({ sdk: '^1.0.0' }), '..')]);
    expect(compatible.ok && compatible.preset.sdk).toBe('^1.0.0');
  });

  it('CONN-8 an invalid sdk range and an invalid version range are issues', async () => {
    const root = join(await installWithAiops({ sdk: 'newest' }), '..');
    expect(await resolvePreset(ENTRY, [root])).toEqual({
      ok: false,
      issues: [{ file: '@aiops/fake-preset/package.json', path: 'aiops.sdk', message: 'must be a semver range' }],
    });
    expect(await resolvePreset({ ...ENTRY, version: 'latest please' }, [root])).toEqual({
      ok: false,
      issues: [{ file: '.', path: 'presets.fake.version', message: 'must be a semver version or range' }],
    });
    const plain = await tempDir();
    await install(plain, 'fake', '0.1.5');
    const ranged = await resolvePreset({ ...ENTRY, version: '^0.1.0' }, [plain]);
    expect(ranged.ok && ranged.preset.version).toBe('0.1.5');
  });

  it('CONN-8 aiops.preset names another preset file inside the package; a path outside is refused', async () => {
    const dir = await installWithAiops({ preset: 'alt/main.yaml', sdk: '^1.0.0' });
    await mkdir(join(dir, 'alt'));
    await writeFile(join(dir, 'alt', 'main.yaml'), await readFile(join(dir, 'preset.yaml'), 'utf8'));
    await rm(join(dir, 'preset.yaml'));
    const result = await resolvePreset(ENTRY, [join(dir, '..')]);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.preset.source.file).toBe('@aiops/fake-preset/alt/main.yaml');
    expect(result.preset.files.map((f) => f.file)).toEqual(['@aiops/fake-preset/package.json', '@aiops/fake-preset/alt/main.yaml', '@aiops/fake-preset/spec.json']);

    const outsideIssue = { file: '@aiops/fake-preset/package.json', path: 'aiops.preset', message: 'must be a path inside the preset' };
    const outside = await installWithAiops({ preset: '../preset.yaml', sdk: '^1.0.0' });
    await writeFile(join(outside, '..', 'preset.yaml'), await readFile(join(outside, 'preset.yaml'), 'utf8'));
    expect(await resolvePreset(ENTRY, [join(outside, '..')])).toEqual({ ok: false, issues: [outsideIssue] });
    const absolute = await installWithAiops({ preset: join(outside, 'preset.yaml'), sdk: '^1.0.0' });
    expect(await resolvePreset(ENTRY, [join(absolute, '..')])).toEqual({ ok: false, issues: [outsideIssue] });
    const linked = await installWithAiops({ preset: 'linked.yaml', sdk: '^1.0.0' });
    await symlink(join(outside, 'preset.yaml'), join(linked, 'linked.yaml'));
    expect(await resolvePreset(ENTRY, [join(linked, '..')])).toEqual({ ok: false, issues: [outsideIssue] });
  });

  it('CONN-8 an mcp preset has no spec; an openapi preset requires one', async () => {
    const root = await tempDir();
    const dir = await install(root, 'fake');
    await writeFile(join(dir, 'preset.yaml'), 'version: 1\nadapter: mcp\nauth: { scheme: bearer }\n');
    const mcp = await resolvePreset(ENTRY, [root]);
    if (!mcp.ok) throw new Error(JSON.stringify(mcp.issues));
    expect(mcp.preset.adapter).toBe('mcp');
    expect(mcp.preset.specFile).toBeUndefined();
    expect(mcp.preset.files.map((f) => f.file)).toEqual(['@aiops/fake-preset/package.json', '@aiops/fake-preset/preset.yaml']);

    await writeFile(join(dir, 'preset.yaml'), 'version: 1\nadapter: mcp\nspec: spec.json\n');
    expect(await resolvePreset(ENTRY, [root])).toEqual({
      ok: false,
      issues: [{ file: '@aiops/fake-preset/preset.yaml', path: 'spec', line: 3, column: 1, message: 'is not allowed for an mcp preset' }],
    });
    await writeFile(join(dir, 'preset.yaml'), 'version: 1\nadapter: openapi\n');
    expect(await resolvePreset(ENTRY, [root])).toEqual({
      ok: false,
      issues: [{ file: '@aiops/fake-preset/preset.yaml', path: 'spec', line: 1, column: 1, message: 'is required for an openapi preset' }],
    });
  });

  it('CONN-8 a package without aiops loads with the Phase 3 defaults', async () => {
    const result = await resolvePreset(ENTRY, [join(PRESET, '..')]);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.preset).toMatchObject({ adapter: 'openapi', version: '0.1.0', specFile: join(PRESET, 'spec.json') });
    expect(result.preset.sdk).toBeUndefined();
    expect(result.preset.source.file).toBe('@aiops/fake-preset/preset.yaml');
  });
});
