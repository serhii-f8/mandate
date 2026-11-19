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

async function run(argv: string[], store: ConfigRevisionStore, env: Record<string, string | undefined> = { DATABASE_URL }, extra: Partial<CliDeps> = {}): Promise<Run> {
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
    ...extra,
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

describe('CFG-3 POL-7 aiops config explain', () => {
  const explain = (...flags: string[]): string[] => ['config', 'explain', ...flags];

  it('CFG-3 POL-7 config explain exits 0 for allow, 1 for deny, 2 for usage', async () => {
    const { store } = fixture();
    await bootstrap(store, await configDir());
    const allowed = await run(explain('--operation', 'shop.list_items', '--groups', 'other,viewers', '--subject', 'alice'), store);
    expect(allowed.lines).toEqual(['effect: allow', 'rule: role:viewer/grant:0', 'roles: viewer', 'reason: -', 'detail: -']);
    expect(allowed.code).toBe(0);
    expect(allowed.closed).toBe(1);

    const denied = await run(explain('--operation', 'shop.get_item', '--groups', 'viewers', '--args', '{"sku":"A-1"}'), store);
    expect(denied.lines).toEqual(['effect: deny', 'rule: default-deny', 'roles: viewer', 'reason: no_grant', 'detail: -']);
    expect(denied.code).toBe(1);

    const invalid = await run(explain('--operation', 'shop.get_item', '--groups', 'viewers'), store);
    expect(invalid.lines[0]).toBe('effect: invalid_arguments');
    expect(invalid.code).toBe(1);

    const usage: string[][] = [
      explain('--groups', 'viewers'),
      explain('--operation', 'shop.list_items'),
      explain('--operation', 'shop.list_items', '--groups', ''),
      explain('--operation', 'shop.list_items', '--groups'),
      explain('--operation', 'shop.list_items', '--groups', 'viewers', '--args', '[1]'),
      explain('--operation', 'shop.list_items', '--groups', 'viewers', '--args', 'null'),
      explain('--operation', 'shop.list_items', '--groups', 'viewers', '--args', '{not json'),
      explain('--operation', 'shop.list_items', '--groups', 'viewers', '--records', '0'),
      explain('--operation', 'shop.list_items', '--groups', 'viewers', '--records', '1.5'),
      explain('--operation', 'shop.list_items', '--groups', 'viewers', '--records', '1000001'),
      explain('--operation', 'shop.list_items', '--groups', 'viewers', '--records', '1e3'),
      explain('--operation', 'shop.list_items', '--groups', 'viewers', '--foo', 'x'),
      explain('--operation', 'shop.list_items', '--operation', 'shop.get_item', '--groups', 'viewers'),
      explain('shop.list_items', '--groups', 'viewers'),
    ];
    for (const argv of usage) {
      const result = await run(argv, store);
      expect(result.code, argv.join(' ')).toBe(2);
      expect(result.closed, argv.join(' ')).toBe(0);
    }
    expect((await run(explain('--operation', 'shop.list_items', '--groups', 'viewers', '--records', '1000000'), store)).code).toBe(0);
    const secret = await run(explain('--operation', 'shop.list_items', '--groups', 'viewers', '--args', '{"secret-value"'), store);
    expect(secret.lines.join('\n')).not.toContain('secret-value');
  });

  it('CFG-3 POL-7 config explain writes no audit row and no revision', async () => {
    const { store, audit } = fixture();
    await bootstrap(store, await configDir());
    await run(explain('--operation', 'shop.list_items', '--groups', 'viewers'), store);
    await run(explain('--operation', 'shop.list_items', '--groups', 'nobody'), store);
    await run(explain('--operation', 'shop.get_item', '--groups', 'viewers'), store);
    expect(audit.events).toEqual([]);
    expect(await store.activeSeq()).toBe(1);
  });

  it('CFG-3 config explain without an active revision exits 2', async () => {
    const empty = fixture();
    const none = await run(explain('--operation', 'shop.list_items', '--groups', 'viewers'), empty.store);
    expect(none.lines).toEqual(['no active configuration: start the api once or run aiops config apply']);
    expect(none.code).toBe(2);
    expect(none.closed).toBe(1);

    const other = fixture();
    await other.store.bootstrap({ id: '00000000-0000-4000-8000-000000000009', hash: 'a'.repeat(64), files: { 'config.yaml': 'version: 1\n' }, summary: { connections: 0, operations: 0, roles: 0, notifications: 0 } });
    const mismatch = await run(explain('--operation', 'shop.list_items', '--groups', 'viewers'), other.store);
    expect(mismatch.lines).toEqual(['configuration_mismatch']);
    expect(mismatch.code).toBe(2);

    expect((await run(explain('--operation', 'shop.list_items', '--groups', 'viewers'), empty.store, {})).code).toBe(2);
  });
});

describe('AUD-7 CFG-3 aiops audit retention reads the active revision', () => {
  const retention = ['audit', 'retention', '--now'];
  let pools = 0;
  const openPool: CliDeps['openPool'] = () => {
    pools += 1;
    return Promise.reject(new Error('the retention pool must not open'));
  };

  it('AUD-7 CFG-3 audit retention --now without an active revision exits 2 before touching the audit table', async () => {
    pools = 0;
    const dir = await configDir();
    const empty = fixture();
    const none = await run(retention, empty.store, { DATABASE_URL, AIOPS_CONFIG_DIR: dir }, { openPool });
    expect(none.lines).toEqual(['no active configuration: start the api once or run aiops config apply']);
    expect(none.code).toBe(2);
    expect(none.closed).toBe(1);
    expect(pools).toBe(0);
  });

  it('AUD-7 CFG-3 audit retention --now refuses an active revision that cannot be loaded here with exit 2', async () => {
    pools = 0;
    const other = fixture();
    await other.store.bootstrap({ id: '00000000-0000-4000-8000-000000000009', hash: 'a'.repeat(64), files: { 'config.yaml': 'version: 1\n' }, summary: { connections: 0, operations: 0, roles: 0, notifications: 0 } });
    const mismatch = await run(retention, other.store, { DATABASE_URL }, { openPool });
    expect(mismatch.lines).toEqual(['configuration_mismatch']);
    expect(mismatch.code).toBe(2);

    const invalid = fixture();
    await invalid.store.bootstrap({ id: '00000000-0000-4000-8000-000000000008', hash: 'b'.repeat(64), files: { 'config.yaml': 'version: 99\n' }, summary: { connections: 0, operations: 0, roles: 0, notifications: 0 } });
    const refused = await run(retention, invalid.store, { DATABASE_URL }, { openPool });
    expect(refused.lines).toEqual(['active revision 00000000-0000-4000-8000-000000000008 cannot be loaded here (invalid)']);
    expect(refused.code).toBe(2);
    expect(pools).toBe(0);
  });

  it('AUD-7 CFG-3 audit retention --now needs no AIOPS_CONFIG_DIR, only DATABASE_URL', async () => {
    const { store } = fixture();
    await bootstrap(store, await configDir());
    const missing = await run(retention, store, {}, { openPool });
    expect(missing.lines.join('\n')).toMatch(/DATABASE_URL/);
    expect(missing.lines.join('\n')).not.toMatch(/AIOPS_CONFIG_DIR/);
    expect(missing.code).toBe(2);
  });
});
