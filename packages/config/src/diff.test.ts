import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { diffConfigurations, diffCounts, formatDiff } from './diff.js';
import { loadConfigurationDirectory, type LoadedConfiguration } from './load.js';

const VALID_DIR = fileURLToPath(new URL('../test/fixtures/valid', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../test/fixtures', import.meta.url));

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

  it('CFG-3 manage_credentials and view_audit changes are reported as role keys', async () => {
    const before = await load(VALID_DIR);
    const after = await edited(async (file) => {
      await file('roles.yaml', (t) => t.replace('    description: Edits product content.\n', '    description: Edits product content.\n    manage_credentials: [magento-integration]\n    view_audit: true\n'));
    });
    expect(formatDiff(diffConfigurations(before, after))).toEqual(['~ role content_manager: manage_credentials, view_audit', hashLine(before, after)]);
  });

  it('CFG-3 a role notify change is reported as key notify', async () => {
    const withNotification = async (notify: string): Promise<LoadedConfiguration> =>
      edited(async (file) => {
        await file('connections.yaml', (t) => `${t}notifications:\n  - id: ops-mail\n    kind: email\n    to: [ops@example.test]\n`);
        await file('roles.yaml', (t) => t.replace('    description: Edits product content.\n', `    description: Edits product content.\n${notify}`));
      });
    const before = await withNotification('');
    const after = await withNotification('    notify: { approval_requests: [ops-mail] }\n');
    expect(formatDiff(diffConfigurations(before, after))).toEqual(['~ role content_manager: notify', hashLine(before, after)]);
  });

  it('CFG-3 Map and Set values compare by content, whatever their insertion order', async () => {
    const before = await load(VALID_DIR);
    const [connection] = before.connections;
    if (connection === undefined) throw new Error('fixture has a connection');
    const withValues = (map: Map<string, number>, set: Set<string>): LoadedConfiguration =>
      ({ ...before, connections: [{ ...connection, extraMap: map, extraSet: set } as unknown as typeof connection] });
    const a = withValues(new Map([['x', 1], ['y', 2]]), new Set(['p', 'q']));
    expect(diffConfigurations(a, withValues(new Map([['y', 2], ['x', 1]]), new Set(['q', 'p']))).changes).toEqual([]);
    expect(diffConfigurations(a, withValues(new Map([['x', 1], ['y', 3]]), new Set(['p', 'q']))).changes).toEqual([{ kind: 'connection', id: connection.id, change: 'changed', keys: ['extraMap'] }]);
    expect(diffConfigurations(a, withValues(new Map([['x', 1], ['y', 2]]), new Set(['p']))).changes).toEqual([{ kind: 'connection', id: connection.id, change: 'changed', keys: ['extraSet'] }]);
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

  it('CFG-3 AUTH-4 diff reports service accounts', async () => {
    const withAccount = async (role: string): Promise<LoadedConfiguration> =>
      edited(async (_file, dir) => {
        await writeFile(join(dir, 'service-accounts.yaml'), `version: 1\nservice_accounts:\n  - { client_id: aiops-sa-ci, role: ${role}, description: CI }\n`);
      });
    const before = await load(VALID_DIR);
    const added = await withAccount('support_agent');
    expect(formatDiff(diffConfigurations(before, added))).toEqual(['+ service_account aiops-sa-ci', hashLine(before, added)]);
    const changed = await withAccount('content_manager');
    expect(formatDiff(diffConfigurations(added, changed))).toEqual(['~ service_account aiops-sa-ci: role', hashLine(added, changed)]);
    const kinds = diffConfigurations(undefined, added).changes.map((c) => c.kind);
    expect(kinds.lastIndexOf('role')).toBeLessThan(kinds.indexOf('service_account'));
    expect(kinds.indexOf('service_account')).toBeLessThan(kinds.indexOf('setting'));
  });

  it('CFG-4 diffCounts counts added, removed and changed', async () => {
    const before = await load(VALID_DIR);
    const after = await edited(async (file) => {
      await file('roles.yaml', (t) => t.replace(/ {2}- id: content_manager[\s\S]*?(?= {2}- id: support_agent)/, ''));
      await file('nested/mapping.yaml', (t) => `${t.replace('  - group: content\n    roles: [content_manager]\n', '')}  - group: extra\n    roles: [support_agent]\n`);
    });
    expect(diffCounts(diffConfigurations(before, after))).toEqual({ added: 0, removed: 1, changed: 1 });
  });

  it('CFG-3 CONN-8 a preset version change is a changed preset entity', async () => {
    const config = await mkdtemp(join(tmpdir(), 'aiops-diff-preset-config-'));
    const presets = await mkdtemp(join(tmpdir(), 'aiops-diff-presets-'));
    dirs.push(config, presets);
    await cp(join(FIXTURES, 'with-preset'), config, { recursive: true });
    await writeFile(join(config, 'config.yaml'), (await readFile(join(config, 'config.yaml'), 'utf8')).replace('version: "0.1.0"', 'version: "^0.1.0"'));
    await cp(join(FIXTURES, 'preset-dir'), presets, { recursive: true });
    const loadWithPresets = async (): Promise<LoadedConfiguration> => {
      const result = await loadConfigurationDirectory(config, { presetDirs: [presets] });
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      return result.configuration;
    };
    const before = await loadWithPresets();
    expect(formatDiff(diffConfigurations(undefined, before))).toContain('+ preset fake');
    const packageJson = join(presets, 'fake-preset', 'package.json');
    await writeFile(packageJson, (await readFile(packageJson, 'utf8')).replace('"version": "0.1.0"', '"version": "0.1.1"'));
    const after = await loadWithPresets();
    expect(formatDiff(diffConfigurations(before, after))).toEqual(['~ preset fake: files, version', hashLine(before, after)]);
    const kinds = diffConfigurations(undefined, after).changes.map((c) => c.kind);
    expect(kinds.indexOf('preset')).toBeGreaterThan(kinds.lastIndexOf('notification'));
    expect(kinds.indexOf('preset')).toBeLessThan(kinds.indexOf('setting'));
  });
});

