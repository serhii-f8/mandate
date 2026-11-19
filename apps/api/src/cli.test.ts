import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CredentialHandle, CredentialStatus, CredentialVault } from '@aiops/core';
import { InMemoryAuditLog, startFakeUpstream, type FakeUpstream } from '@aiops/testing';
import { loadConfigurationDirectory } from '@aiops/config';
import { runApiCli, type CliDeps, type CliStore, type StoreInput } from './cli.js';

const DEV_CONFIG = fileURLToPath(new URL('../../../deploy/config', import.meta.url));
const REPO_PRESETS = fileURLToPath(new URL('../../../presets', import.meta.url));
const FIXTURE_CONFIG = fileURLToPath(new URL('../test/e2e/fixtures/credentials-config', import.meta.url));
const TOKEN = 'unit-only-cli-token-value-0123456789';

class MemoryVault implements CredentialVault {
  readonly rows = new Map<string, { scheme: string; secret: Readonly<Record<string, string>> }>();
  put(input: { ref: string; scheme: string; secret: Readonly<Record<string, string>>; actor: string }): Promise<{ keyVersion: number }> {
    this.rows.set(input.ref, { scheme: input.scheme, secret: input.secret });
    return Promise.resolve({ keyVersion: 1 });
  }
  describe(refs: readonly string[]): Promise<CredentialStatus[]> {
    return Promise.resolve(refs.map((ref) => ({ ref, set: this.rows.has(ref) })));
  }
  handle(ref: string): Promise<CredentialHandle | undefined> {
    const row = this.rows.get(ref);
    return Promise.resolve(row === undefined ? undefined : { ref, scheme: row.scheme, open: () => Promise.resolve(row.secret) });
  }
}

let upstream: FakeUpstream;
let configDir: string;

beforeAll(async () => {
  upstream = await startFakeUpstream();
  upstream.route('GET', '/rest/V1/products', () => ({ status: 200, body: { items: [{ sku: 'a' }, { sku: 'b' }], total_count: 2 } }));
  configDir = await mkdtemp(join(tmpdir(), 'aiops-cli-unit-'));
  await cp(FIXTURE_CONFIG, configDir, { recursive: true });
  const connections = join(configDir, 'connections.yaml');
  await writeFile(connections, (await readFile(connections, 'utf8')).replaceAll('__UPSTREAM_URL__', upstream.url));
});

afterAll(async () => {
  await upstream.close();
  await rm(configDir, { recursive: true });
});

interface Run {
  readonly code: number;
  readonly lines: readonly string[];
  readonly audit: InMemoryAuditLog;
  readonly storeInputs: readonly StoreInput[];
}

async function run(argv: string[], env: Record<string, string> = {}, stored = true): Promise<Run> {
  const lines: string[] = [];
  const vault = new MemoryVault();
  if (stored) await vault.put({ ref: 'shop-token', scheme: 'bearer', secret: { token: TOKEN }, actor: 'setup' });
  let audit = new InMemoryAuditLog();
  const storeInputs: StoreInput[] = [];
  const deps: CliDeps = {
    env: { AIOPS_CONFIG_DIR: configDir, DATABASE_URL: 'postgres://u:p@h/db', AIOPS_MASTER_KEYS: 'x', ...env },
    openStore: (input) => {
      storeInputs.push(input);
      // Like openStoreDefault: the store's audit log redacts with the keys it is opened with.
      const { sensitiveKeys } = input;
      audit = new InMemoryAuditLog(sensitiveKeys === undefined ? {} : { sensitiveKeys: () => sensitiveKeys });
      return Promise.resolve({
        vault,
        audit,
        rotate: () => Promise.resolve({ rewrapped: 0, onOldVersions: 0, failed: [] }),
        close: () => Promise.resolve(),
      } satisfies CliStore);
    },
    newId: () => 'id-1',
    // Do not pick up the repository's presets directory in these tests.
    defaultPresetDir: null,
  };
  const code = await runApiCli(argv, (line) => lines.push(line), deps);
  return { code, lines, audit, storeInputs };
}

describe('CFG-3 aiops validate and test-connection', () => {
  it('CFG-3 validate of the development configuration exits 0', async () => {
    const { code, lines } = await run(['validate', DEV_CONFIG, '--preset-dir', REPO_PRESETS]);
    // support.lookup_order from configuration, plus the four Magento preset operations (search, get, get by SKU, update content).
    expect(lines.join('\n')).toMatch(/^Configuration valid: 1 connections, 5 operations, 4 roles$/m);
    expect(lines.join('\n')).not.toContain('skipped');
    expect(code).toBe(0);
  });

  it('POL-5 APR-3 the development configuration routes content_manager approvals above 25 changes to content_lead', async () => {
    const result = await loadConfigurationDirectory(DEV_CONFIG, { presetDirs: [REPO_PRESETS] });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.configuration.approval.get('content_manager')).toEqual({
      required: 'above_threshold',
      recordThreshold: 25,
      steps: ['content_lead'],
      allowWidget: false,
    });
    expect(result.configuration.policy.roleMapping).toContainEqual({ group: 'content-leads', roles: ['content_lead'] });
  });

  it('CFG-3 CONN-2 validate resolves specs and exits 1 with the located issue', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'aiops-cli-broken-'));
    try {
      await cp(DEV_CONFIG, broken, { recursive: true });
      const file = join(broken, 'connections.yaml');
      await writeFile(file, (await readFile(file, 'utf8')) + '    openapi: { spec: specs/missing.json }\n');
      const { code, lines } = await run(['validate', broken]);
      expect(code).toBe(1);
      expect(lines[0]).toMatch(/^connections\.yaml:\d+:\d+ connections\[0\]\.openapi\.spec: spec file cannot be read$/);
      expect(lines.at(-1)).toBe('Configuration invalid: 1 issue');
    } finally {
      await rm(broken, { recursive: true });
    }
  });

  it('CFG-3 validate without a directory is a usage error (exit 2)', async () => {
    const { code, lines } = await run(['validate']);
    expect(code).toBe(2);
    expect(lines[0]).toMatch(/^usage: /);
  });

  it('CFG-3 validate with presets declared and no preset directory exits 1 and says so', async () => {
    // The development configuration applies the Magento preset; this run has no preset directory.
    const { code, lines } = await run(['validate', DEV_CONFIG]);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('preset directories not set');
  });

  it('CONN-7 test-connection prints the result line, audits as cli and exits 0', async () => {
    const { code, lines, audit } = await run(['test-connection', 'shop']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ok status=200 items=2 ms=\d+ scopes=not detectable$/);
    expect(code).toBe(0);
    expect(audit.events).toEqual([
      expect.objectContaining({ actor: 'cli', clientId: 'cli', action: 'connection.test', subject: 'shop', outcome: 'ok' }),
    ]);
    expect(JSON.stringify([lines, audit.events])).not.toContain(TOKEN);
  });

  it('CONN-7 test-connection without a stored credential exits 1 with credential_missing', async () => {
    const { code, lines, audit } = await run(['test-connection', 'shop'], {}, false);
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^failed code=credential_missing /);
    expect(audit.events[0]).toMatchObject({ outcome: 'error', details: { code: 'credential_missing' } });
  });

  it('CONN-7 test-connection of an unknown connection or one without a test exits 1; no name is usage (2)', async () => {
    expect((await run(['test-connection', 'nope'])).code).toBe(1);
    const noTest = await run(['test-connection', 'erp']);
    expect(noTest.code).toBe(1);
    expect(noTest.lines[0]).toContain('no connection test is declared');
    expect((await run(['test-connection'])).code).toBe(2);
    expect((await run(['bogus'])).code).toBe(2);
  });

  it('CFG-3 test-connection names the missing or invalid variable, never a value', async () => {
    const lines: string[] = [];
    const code = await runApiCli(['test-connection', 'shop'], (line) => lines.push(line), { env: {} });
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/AIOPS_CONFIG_DIR/);
    const lines2: string[] = [];
    const code2 = await runApiCli(['test-connection', 'shop'], (line) => lines2.push(line), {
      env: { AIOPS_CONFIG_DIR: configDir, DATABASE_URL: 'not-a-url-secret-value', AIOPS_MASTER_KEYS: 'k' },
    });
    expect(code2).toBe(2);
    expect(lines2.join('\n')).toMatch(/DATABASE_URL/);
    expect(lines2.join('\n')).not.toContain('not-a-url-secret-value');
  });
});

describe('AUD-4 the CLI audit log gets the loaded configuration\'s sensitive keys', () => {
  // A write operation whose manifest marks `description` sensitive, beside the fixture's reads.
  const SENSITIVE_OPERATIONS = `version: 1
operations:
  - id: audit.get_by_sku
    connection: shop
    risk: read
    description: Products by SKU.
    upstream: { method: GET, path: /V1/products, query: { skus: { arg: skus, join: ',' }, brand: { arg: brand }, fields: { arg: fields, join: ',' } }, response: { items: items, fields_from_arg: fields } }
    input_schema:
      type: object
      properties: { skus: { type: array, items: { type: string } }, brand: { type: string }, fields: { type: array, items: { type: string } } }
      required: [skus, fields]
    fields_arg: fields
  - id: audit.search
    connection: shop
    risk: read
    description: Search.
    upstream: { method: GET, path: /V1/products/search, query: { brand: { arg: brand }, current_page: { arg: current_page }, page_size: { arg: page_size }, fields: { arg: fields, join: ',' } }, response: { items: items, fields_from_arg: fields } }
    input_schema:
      type: object
      properties: { brand: { type: string }, current_page: { type: integer }, page_size: { type: integer }, fields: { type: array, items: { type: string } } }
      required: [fields]
    fields_arg: fields
  - id: audit.update_content
    connection: shop
    risk: write
    description: Update content.
    upstream: { method: POST, path: /async/bulk/V1/products }
    input_schema:
      type: object
      properties:
        brand: { type: string }
        skus: { type: array, items: { type: string } }
        changes: { type: object, properties: { name: { type: string }, description: { type: string } }, additionalProperties: false }
      required: [brand, changes]
    manifest:
      id_field: sku
      ids_arg: skus
      values_arg: changes
      fields: [name, description]
      scope_args: { brand: brand }
      read_before: { operation: audit.get_by_sku, ids_arg: skus, args: { brand: { arg: brand } } }
      selector: { operation: audit.search, args: { brand: { arg: brand } }, page_arg: current_page, page_size_arg: page_size }
      sensitive_fields: [description]
      rollback: { strategy: replay_previous_state }
`;

  it('AUD-4 test-connection opens the store with the loaded configuration\'s sensitive fields', async () => {
    const sensitiveDir = await mkdtemp(join(tmpdir(), 'aiops-cli-sensitive-'));
    try {
      await cp(configDir, sensitiveDir, { recursive: true });
      await writeFile(join(sensitiveDir, 'sensitive.yaml'), SENSITIVE_OPERATIONS);
      const { code, lines, storeInputs, audit } = await run(['test-connection', 'shop'], { AIOPS_CONFIG_DIR: sensitiveDir });
      expect(lines[0]).toMatch(/^ok /);
      expect(code).toBe(0);
      expect(storeInputs).toHaveLength(1);
      expect([...(storeInputs[0]?.sensitiveKeys ?? [])]).toEqual(['description']);
      // The store's audit log redacts the manifest key; a probe event shows the set reached it.
      await audit.append({ id: 'probe', actor: 'cli', action: 'connection.test', outcome: 'ok', correlationId: 'c', details: { description: 'copy', count: 1 } });
      expect(audit.events.at(-1)?.details).toEqual({ description: '[redacted]', count: 1 });
    } finally {
      await rm(sensitiveDir, { recursive: true });
    }
  });

  it('AUD-4 rotate loads no configuration and opens the store without sensitive keys', async () => {
    const { code, storeInputs } = await run(['credentials', 'rotate']);
    expect(code).toBe(0);
    expect(storeInputs).toHaveLength(1);
    expect(storeInputs[0]).not.toHaveProperty('sensitiveKeys');
  });
});
