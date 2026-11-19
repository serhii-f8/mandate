import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenApiAdapter, type OpenApiAdapter } from '@aiops/adapters';
import { loadConfigurationDirectory, revisionFilesOf, revisionSummary } from '@aiops/config';
import type { ConfigRevisionStore } from '@aiops/core';
import { FakeResolver, fakeCatalogEntry, InMemoryAuditLog, InMemoryConfigRevisionStore } from '@aiops/testing';
import { runApiCli, type CliDeps } from './cli.js';

const SHOP_SPEC = fileURLToPath(new URL('../../../packages/config/test/fixtures/derived/specs/shop.json', import.meta.url));
const DATABASE_URL = 'postgres://u:p@h/db';

const CONFIG_YAML = [
  'version: 1',
  'connections:',
  '  - id: shop',
  '    adapter: openapi',
  '    base_url: https://shop.example.test/api',
  '    openapi: { spec: specs/shop.json, include: [listItems, getItem] }',
  'operations:',
  '  - id: shop.list_items',
  '    connection: shop',
  '    risk: read',
  '    description: List items.',
  '    upstream: { operation: listItems, response: { items: items } }',
  '  - id: shop.get_item',
  '    connection: shop',
  '    risk: read',
  '    description: Get one item.',
  '    upstream: { operation: getItem }',
  '',
].join('\n');

const rolesYaml = (operations: readonly string[]): string =>
  [
    'version: 1',
    'roles:',
    '  - id: viewer',
    operations.length === 0 ? '    grants: []' : '    grants:',
    ...operations.map((op) => `      - operation: ${op}`),
    'role_mapping:',
    '  - group: viewers',
    '    roles: [viewer]',
    '',
  ].join('\n');

const adapter = (): OpenApiAdapter => ({
  ...createOpenApiAdapter(),
  resolver: new FakeResolver({
    shop: [
      fakeCatalogEntry('shop', { operationId: 'listItems', method: 'GET', path: '/items' }),
      fakeCatalogEntry('shop', { operationId: 'getItem', method: 'GET', path: '/items/{sku}' }),
    ],
  }),
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A configuration directory whose role `viewer` holds the given grants. */
async function configDir(grants: readonly string[] = ['shop.list_items']): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aiops-cli-config-'));
  dirs.push(dir);
  await mkdir(join(dir, 'specs'));
  await cp(SHOP_SPEC, join(dir, 'specs', 'shop.json'));
  await writeFile(join(dir, 'config.yaml'), CONFIG_YAML);
  await writeFile(join(dir, 'roles.yaml'), rolesYaml(grants));
  return dir;
}

interface Fixture {
  readonly audit: InMemoryAuditLog;
  readonly store: InMemoryConfigRevisionStore;
}

function fixture(): Fixture {
  const audit = new InMemoryAuditLog();
  return { audit, store: new InMemoryConfigRevisionStore(audit) };
}

/** Bootstraps `dir`'s files as the active revision. */
async function bootstrap(store: InMemoryConfigRevisionStore, dir: string): Promise<{ id: string; hash: string }> {
  const result = await loadConfigurationDirectory(dir, { resolver: adapter().resolver });
  if (!result.ok) throw new Error(`fixture invalid: ${JSON.stringify(result.issues)}`);
  const files = revisionFilesOf(result.configuration);
  if (!files.ok) throw new Error('fixture files refused');
  const id = '00000000-0000-4000-8000-000000000001';
  await store.bootstrap({ id, hash: result.configuration.hash, files: files.files, summary: revisionSummary(result.configuration) });
  return { id, hash: result.configuration.hash };
}

interface Run {
  readonly code: number;
  readonly lines: readonly string[];
  readonly closed: number;
}

async function run(argv: string[], store: ConfigRevisionStore, env: Record<string, string | undefined> = { DATABASE_URL }): Promise<Run> {
  const lines: string[] = [];
  let next = 0;
  let closed = 0;
  const deps: CliDeps = {
    env,
    adapter: adapter(),
    openConfigStore: () =>
      Promise.resolve({
        store,
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      }),
    newId: () => `00000000-0000-4000-8000-1000000000${String((next += 1)).padStart(2, '0')}`,
    defaultPresetDir: null,
  };
  const code = await runApiCli(argv, (line) => lines.push(line), deps);
  return { code, lines, closed };
}

describe('CFG-3 CFG-4 aiops config diff and apply', () => {
  it('CFG-3 diff of the active configuration prints No changes and exits 0', async () => {
    const dir = await configDir();
    const { store } = fixture();
    await bootstrap(store, dir);
    const result = await run(['config', 'diff', dir], store);
    expect(result.lines).toEqual(['No changes']);
    expect(result.code).toBe(0);
    expect(result.closed).toBe(1);
  });

  it('CFG-3 diff of a new grant prints the role line and the hash line', async () => {
    const { store } = fixture();
    const active = await bootstrap(store, await configDir());
    const changed = await configDir(['shop.list_items', 'shop.get_item']);
    const result = await run(['config', 'diff', changed], store);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toBe('~ role viewer: grants');
    expect(result.lines[1]).toMatch(new RegExp(`^hash ${active.hash} -> [0-9a-f]{64}$`));
    expect(result.code).toBe(0);
    expect((await store.active())?.id).toBe(active.id);
  });

  it('CFG-3 diff of an invalid directory prints the issues and exits 1', async () => {
    const { store } = fixture();
    await bootstrap(store, await configDir());
    const dir = await configDir(['shop.no_such_operation']);
    const result = await run(['config', 'diff', dir], store);
    expect(result.code).toBe(1);
    expect(result.lines.at(-1)).toMatch(/^Configuration invalid: \d+ issues?$/);
    expect(result.lines.join('\n')).toContain('roles.yaml');
  });

  it('CFG-3 an active revision that cannot be loaded here is shown as added against its stored hash', async () => {
    const { store } = fixture();
    const dir = await configDir();
    const stored = 'a'.repeat(64);
    await store.bootstrap({ id: '00000000-0000-4000-8000-000000000009', hash: stored, files: { 'config.yaml': 'version: 1\n' }, summary: { connections: 0, operations: 0, roles: 0, notifications: 0 } });
    const result = await run(['config', 'diff', dir], store);
    expect(result.lines[0]).toBe('active revision 00000000-0000-4000-8000-000000000009 cannot be loaded here (configuration_mismatch); every entity is shown as added');
    expect(result.lines).toContain('+ connection shop');
    expect(result.lines).toContain('+ role viewer');
    expect(result.lines.at(-1)).toMatch(new RegExp(`^hash ${stored} -> [0-9a-f]{64}$`));
    expect(result.code).toBe(0);
  });

  it('CFG-4 apply prints the diff, stores the revision with actor cli:<name> and audits config.apply with counts', async () => {
    const { store, audit } = fixture();
    const active = await bootstrap(store, await configDir());
    const changed = await configDir(['shop.list_items', 'shop.get_item']);
    const result = await run(['config', 'apply', changed, '--actor', 'alice'], store);
    const stored = await store.active();
    expect(stored).toMatchObject({ seq: 2, source: 'apply', actor: 'cli:alice', summary: { connections: 1, operations: 2, roles: 1, notifications: 0 } });
    expect(result.lines).toEqual(['~ role viewer: grants', `hash ${active.hash} -> ${String(stored?.hash)}`, `applied revision ${String(stored?.id)} (seq 2)`]);
    expect(result.code).toBe(0);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      actor: 'cli:alice',
      action: 'config.apply',
      outcome: 'ok',
      details: { revision: stored?.id, hash: stored?.hash, previousHash: active.hash, added: 0, removed: 0, changed: 1 },
    });
    expect(Object.keys(stored?.files ?? {}).sort()).toEqual(['config.yaml', 'roles.yaml', 'specs/shop.json']);
    expect(stored?.files['roles.yaml']).toBe(await readFile(join(changed, 'roles.yaml'), 'utf8'));
  });

  it('CFG-4 apply without changes prints No changes and writes nothing', async () => {
    const { store, audit } = fixture();
    const dir = await configDir();
    await bootstrap(store, dir);
    const result = await run(['config', 'apply', dir, '--actor', 'alice'], store);
    expect(result.lines).toEqual(['No changes']);
    expect(result.code).toBe(0);
    expect(await store.activeSeq()).toBe(1);
    expect(audit.events).toEqual([]);
  });

  it('CFG-4 apply takes cli:$USER without --actor and cli when USER is unusable', async () => {
    const first = fixture();
    await bootstrap(first.store, await configDir());
    const changed = await configDir(['shop.list_items', 'shop.get_item']);
    expect((await run(['config', 'apply', changed], first.store, { DATABASE_URL, USER: 'bob.smith' })).code).toBe(0);
    expect((await first.store.active())?.actor).toBe('cli:bob.smith');
    expect(first.audit.events[0]?.actor).toBe('cli:bob.smith');

    for (const user of [undefined, '', 'bad user', 'x'.repeat(65)]) {
      const other = fixture();
      await bootstrap(other.store, await configDir());
      expect((await run(['config', 'apply', changed], other.store, { DATABASE_URL, USER: user })).code).toBe(0);
      expect((await other.store.active())?.actor).toBe('cli');
      expect(other.audit.events[0]?.actor).toBe('cli');
    }
  });

  it('CFG-3 an --actor outside [A-Za-z0-9._@-]{1,64} is a usage error', async () => {
    const { store, audit } = fixture();
    await bootstrap(store, await configDir());
    const changed = await configDir(['shop.list_items', 'shop.get_item']);
    for (const actor of ['', 'bad actor', 'a/b', 'x'.repeat(65)]) {
      const result = await run(['config', 'apply', changed, '--actor', actor], store);
      expect(result.code).toBe(2);
      expect(result.lines.join('\n')).not.toContain(`cli:${actor}`);
    }
    expect((await run(['config', 'apply', changed, '--actor'], store)).code).toBe(2);
    expect((await run(['config', 'diff', changed, '--actor', 'alice'], store)).code).toBe(2);
    expect(await store.activeSeq()).toBe(1);
    expect(audit.events).toEqual([]);
  });

  it('CFG-4 apply losing a race prints concurrent_apply and exits 1', async () => {
    const { store, audit } = fixture();
    const active = await bootstrap(store, await configDir());
    const theirs = await loadConfigurationDirectory(await configDir([]), { resolver: adapter().resolver });
    if (!theirs.ok) throw new Error('fixture invalid');
    const theirFiles = revisionFilesOf(theirs.configuration);
    if (!theirFiles.ok) throw new Error('fixture files refused');
    // Another operator's apply commits between this command's active() and its apply().
    const racing: ConfigRevisionStore = {
      active: () => store.active(),
      activeSeq: () => store.activeSeq(),
      bootstrap: (revision) => store.bootstrap(revision),
      listen: (handlers) => store.listen(handlers),
      apply: async (revision, event, expected) => {
        const other = { id: '00000000-0000-4000-8000-0000000000ff', hash: theirs.configuration.hash, files: theirFiles.files, actor: 'cli:carol', summary: revisionSummary(theirs.configuration) };
        await store.apply(other, { ...event, id: other.id, actor: 'cli:carol' }, active.hash);
        return store.apply(revision, event, expected);
      },
    };
    const changed = await configDir(['shop.list_items', 'shop.get_item']);
    const result = await run(['config', 'apply', changed, '--actor', 'alice'], racing);
    expect(result.lines.at(-1)).toBe('concurrent_apply: another revision was applied meanwhile; run diff again');
    expect(result.code).toBe(1);
    expect(await store.active()).toMatchObject({ seq: 2, actor: 'cli:carol' });
    expect(audit.events.map((e) => e.actor)).toEqual(['cli:carol']);
  });

  it('CFG-3 diff and apply without DATABASE_URL exit 2 naming the variable', async () => {
    const { store } = fixture();
    const dir = await configDir();
    for (const command of ['diff', 'apply']) {
      for (const env of [{}, { DATABASE_URL: 'mysql://secret-host/db' }]) {
        const result = await run(['config', command, dir], store, env);
        expect(result.code).toBe(2);
        expect(result.lines.join('\n')).toContain('DATABASE_URL');
        expect(result.lines.join('\n')).not.toContain('secret-host');
        expect(result.closed).toBe(0);
      }
    }
    expect((await run(['config', 'diff'], store)).code).toBe(2);
  });

  it('CFG-3 a file key the revision cannot hold (spec outside the directory) makes apply exit 1', async () => {
    const { store, audit } = fixture();
    await bootstrap(store, await configDir());
    const root = await mkdtemp(join(tmpdir(), 'aiops-cli-config-outside-'));
    dirs.push(root);
    const dir = join(root, 'conf');
    await mkdir(dir);
    await cp(SHOP_SPEC, join(root, 'outside.json'));
    await writeFile(join(dir, 'config.yaml'), CONFIG_YAML.replace('spec: specs/shop.json', 'spec: ../outside.json'));
    await writeFile(join(dir, 'roles.yaml'), rolesYaml(['shop.list_items']));
    const result = await run(['config', 'apply', dir, '--actor', 'alice'], store);
    expect(result.lines).toContain('. connections.shop.openapi.spec: spec file must be inside the configuration directory to be applied');
    expect(result.code).toBe(1);
    expect(await store.activeSeq()).toBe(1);
    expect(audit.events).toEqual([]);
  });
});
