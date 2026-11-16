import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError, ConfigurationHolder } from './holder.js';

const VALID_DIR = fileURLToPath(new URL('../test/fixtures/valid', import.meta.url));
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aiops-holder-'));
  await cp(VALID_DIR, dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true });
});

describe('CFG-2 the previous configuration stays active', () => {
  it('keeps the previous configuration when a reload is invalid, and swaps when it is valid', async () => {
    const holder = await ConfigurationHolder.load(dir);
    const first = holder.current;
    await writeFile(join(dir, 'roles.yaml'), 'version: 1\nroles:\n  - id: Broken\n');
    const failed = await holder.reload();
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.issues[0]?.file).toBe('roles.yaml');
    expect(holder.current).toBe(first);

    await writeFile(join(dir, 'roles.yaml'), 'version: 1\nroles:\n  - id: content_manager\n    grants: []\n  - id: support_agent\n    grants: []\n');
    expect((await holder.reload()).ok).toBe(true);
    expect(holder.current.hash).not.toBe(first.hash);
  });

  it('applies overlapping reloads in the order they were requested', async () => {
    const holder = await ConfigurationHolder.load(dir);
    await writeFile(join(dir, 'roles.yaml'), 'version: 1\nroles:\n  - id: content_manager\n    grants: []\n  - id: support_agent\n    grants: []\n');
    const first = holder.reload();
    await writeFile(join(dir, 'roles.yaml'), 'version: 1\nroles:\n  - id: content_manager\n    grants: []\n  - id: support_agent\n    grants: []\n  - id: extra\n    grants: []\n');
    const second = holder.reload();
    await Promise.all([first, second]);
    expect(holder.current.policy.roles.map((r) => r.id)).toContain('extra');
  });

  it('refuses to start from an invalid directory and carries the issues', async () => {
    await writeFile(join(dir, 'roles.yaml'), 'version: 1\nroles: nope\n');
    const error = await ConfigurationHolder.load(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).issues[0]).toMatchObject({ file: 'roles.yaml', path: 'roles' });
  });
});
