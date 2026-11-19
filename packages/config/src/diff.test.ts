import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { diffConfigurations, diffCounts, formatDiff } from './diff.js';
import { loadConfigurationDirectory, type LoadedConfiguration } from './load.js';

const VALID_DIR = fileURLToPath(new URL('../test/fixtures/valid', import.meta.url));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function load(dir: string): Promise<LoadedConfiguration> {
  const result = await loadConfigurationDirectory(dir);
  if (!result.ok) throw new Error(`expected a valid configuration: ${JSON.stringify(result.issues)}`);
  return result.configuration;
}

/** Loads a temp copy of the valid fixture after `edit` changed its files. */
async function edited(edit: (file: (name: string, transform: (text: string) => string) => Promise<void>, dir: string) => Promise<void>): Promise<LoadedConfiguration> {
  const dir = await mkdtemp(join(tmpdir(), 'aiops-diff-test-'));
  dirs.push(dir);
  await cp(VALID_DIR, dir, { recursive: true });
  await edit(async (name, transform) => writeFile(join(dir, name), transform(await readFile(join(dir, name), 'utf8'))), dir);
  return load(dir);
}

const hashLine = (before: LoadedConfiguration, after: LoadedConfiguration): string => `hash ${before.hash} -> ${after.hash}`;

describe('CFG-3 configuration diff', () => {
  it('CFG-3 equal configurations print No changes', async () => {
    const before = await load(VALID_DIR);
    expect(formatDiff(diffConfigurations(before, await load(VALID_DIR)))).toEqual(['No changes']);
  });

  it('CFG-3 a new grant is a changed role with key grants', async () => {
    const before = await load(VALID_DIR);
    const after = await edited(async (file) => {
      await file('roles.yaml', (t) => t.replace('  - id: support_agent', '      - operation: support.lookup_order\n        id: extra\n  - id: support_agent'));
    });
    expect(formatDiff(diffConfigurations(before, after))).toEqual(['~ role content_manager: grants', hashLine(before, after)]);
  });

  it('CFG-3 added and removed entities, in kind order then id order', async () => {
    const before = await load(VALID_DIR);
    const after = await edited(async (file) => {
      await file('operations.yaml', (t) => `${t}  - id: support.lookup_order_2\n    connection: magento\n    risk: read\n    description: Another lookup.\n    upstream: { method: GET, path: /V1/orders2 }\n    input_schema: { type: object, additionalProperties: false }\n`);
      await file('roles.yaml', (t) => t.replace(/ {2}- id: content_manager[\s\S]*?(?= {2}- id: support_agent)/, ''));
      await file('nested/mapping.yaml', (t) => `${t.replace('  - group: content\n    roles: [content_manager]\n', '')}  - group: extra\n    roles: [support_agent]\n`);
    });
    const lines = formatDiff(diffConfigurations(before, after));
    expect(lines).toEqual(['+ operation support.lookup_order_2', '- role content_manager', '~ role support_agent: mapping', hashLine(before, after)]);
  });

  it('CFG-3 changed limits and approval keys are listed sorted', async () => {
    const before = await load(VALID_DIR);
    const after = await edited(async (file) => {
      await file('roles.yaml', (t) => t.replace('    description: Edits product content.\n', '    description: Edits product content.\n    limits: { records_per_day: 5 }\n    approval: { required: always }\n'));
    });
    expect(formatDiff(diffConfigurations(before, after))).toEqual(['~ role content_manager: approval, limits', hashLine(before, after)]);
  });

  it('CFG-3 a settings change lists its keys', async () => {
    const before = await load(VALID_DIR);
    const after = await edited(async (file) => {
      await file('connections.yaml', (t) => `${t}changesets:\n  expire_after_hours: 10\n`);
    });
    expect(formatDiff(diffConfigurations(before, after))).toEqual(['~ setting changesets: expireAfterHours', hashLine(before, after)]);
  });

  it('CFG-3 a comment-only edit prints only the hash line', async () => {
    const before = await load(VALID_DIR);
    const after = await edited(async (file) => {
      await file('roles.yaml', (t) => `# a comment\n${t}`);
    });
    expect(formatDiff(diffConfigurations(before, after))).toEqual([hashLine(before, after)]);
  });

  it('CFG-3 no active configuration lists everything as added with hash none', async () => {
    const after = await load(VALID_DIR);
    const diff = diffConfigurations(undefined, after);
    const lines = formatDiff(diff);
    expect(lines[0]).toBe('+ connection magento');
    expect(lines).toContain('+ role content_manager');
    expect(lines).toContain('+ setting changesets');
    expect(lines.at(-1)).toBe(`hash none -> ${after.hash}`);
    expect(diff.changes.every((c) => c.change === 'added' && c.keys.length === 0)).toBe(true);
  });

  it('CFG-3 an optional key set to undefined, top-level or nested, equals an absent key and does not throw', async () => {
    const before = await load(VALID_DIR);
    const [connection] = before.connections;
    const [role] = before.policy.roles;
    const [grant] = role?.grants ?? [];
    if (connection === undefined || role === undefined || grant === undefined) throw new Error('fixture has a connection, a role and a grant');
    const nested = { ...grant, unsetKey: undefined } as typeof grant;
    const after: LoadedConfiguration = {
      ...before,
      connections: [{ ...connection, unsetKey: undefined } as unknown as typeof connection, ...before.connections.slice(1)],
      policy: { ...before.policy, roles: [{ ...role, grants: [nested, ...role.grants.slice(1)] }, ...before.policy.roles.slice(1)] },
    };
    expect(diffConfigurations(before, after).changes).toEqual([]);
  });

  it('CFG-4 diffCounts counts added, removed and changed', async () => {
    const before = await load(VALID_DIR);
    const after = await edited(async (file) => {
      await file('roles.yaml', (t) => t.replace(/ {2}- id: content_manager[\s\S]*?(?= {2}- id: support_agent)/, ''));
      await file('nested/mapping.yaml', (t) => `${t.replace('  - group: content\n    roles: [content_manager]\n', '')}  - group: extra\n    roles: [support_agent]\n`);
    });
    expect(diffCounts(diffConfigurations(before, after))).toEqual({ added: 0, removed: 1, changed: 1 });
  });
});
