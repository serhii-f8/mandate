import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import type { ReadAdapter, ReadOutcome, ScopeReport } from '@aiops/connector-sdk';
import type { CredentialHandle, CredentialStatus, CredentialVault } from '@aiops/core';
import { InMemoryAuditLog } from '@aiops/testing';
import { ConnectionTestService } from './connection-test.js';

const SOURCES = {
  'connections.yaml': `version: 1
connections:
  - id: magento
    adapter: openapi
    base_url: https://shop.example.test/rest
    credential_ref: magento-integration
    auth: { scheme: bearer }
    test: { operation: catalog.search_products, args: { brand: acme, fields: [sku] } }
  - { id: erp, adapter: openapi, base_url: https://erp.example.test, credential_ref: erp-key, auth: { scheme: api_key, header: x-key } }
`,
  'operations.yaml': `version: 1
operations:
  - id: catalog.search_products
    connection: magento
    risk: read
    description: Search the catalog by brand.
    upstream:
      method: GET
      path: /V1/products
      query: { brand: { arg: brand } }
      response: { items: items, total: total_count, fields_from_arg: fields }
    input_schema:
      type: object
      properties: { brand: { type: string }, fields: { type: array, items: { type: string } } }
      required: [brand, fields]
      additionalProperties: false
    fields_arg: fields
`,
};

const loaded = await loadConfigurationSources(Object.entries(SOURCES).map(([file, text]) => ({ file, text })));
if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
const CONFIG: LoadedConfiguration = loaded.configuration;

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
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ ref, scheme: row.scheme, open: () => Promise.resolve(row.secret) });
  }
}

const JWT_SCOPES: ScopeReport = { detectable: true, source: 'jwt_claims', values: ['catalog:read'] };

class FakeAdapter implements ReadAdapter {
  readonly reads: Parameters<ReadAdapter['read']>[0][] = [];
  readonly detections: Parameters<ReadAdapter['detectScopes']>[0][] = [];
  constructor(
    private readonly outcome: ReadOutcome,
    private readonly scopes: ScopeReport = JWT_SCOPES,
  ) {}
  read(input: Parameters<ReadAdapter['read']>[0]): Promise<ReadOutcome> {
    this.reads.push(input);
    return Promise.resolve(this.outcome);
  }
  detectScopes(input: Parameters<ReadAdapter['detectScopes']>[0]): Promise<ScopeReport> {
    this.detections.push(input);
    return Promise.resolve(this.scopes);
  }
}

const TOKEN = 'unit-only-token-value-0123456789';
const OK: ReadOutcome = { ok: true, status: 200, durationMs: 12, items: [{ sku: 'a' }, { sku: 'b' }], total: 7, truncated: false };

async function setup(outcome: ReadOutcome = OK, { stored = true }: { stored?: boolean } = {}) {
  const vault = new MemoryVault();
  if (stored) await vault.put({ ref: 'magento-integration', scheme: 'bearer', secret: { token: TOKEN }, actor: 'setup' });
  const adapter = new FakeAdapter(outcome);
  const audit = new InMemoryAuditLog();
  let n = 0;
  const service = new ConnectionTestService({ configuration: () => CONFIG, vault, adapter, audit, newId: () => `id-${String(++n)}` });
  return { vault, adapter, audit, service };
}

describe('CONN-7 connection test service', () => {
  it('CONN-7 SEC-7 runs the declared test read with the stored credential and reports items and scopes', async () => {
    const { adapter, service, audit } = await setup();
    const report = await service.run('magento', 'carol-id', 'aiops-web', 'corr-1');
    expect(report).toEqual({ ok: true, operation: 'catalog.search_products', status: 200, durationMs: 12, itemCount: 2, scopes: JWT_SCOPES });
    expect(adapter.reads).toHaveLength(1);
    expect(adapter.reads[0]?.args).toEqual({ brand: 'acme', fields: ['sku'] });
    expect(adapter.reads[0]?.mapping).toMatchObject({ method: 'GET', path: '/V1/products' });
    expect(adapter.reads[0]?.connection.id).toBe('magento');
    expect(await adapter.reads[0]?.credential?.open()).toEqual({ token: TOKEN });
    expect(adapter.detections[0]?.credential?.ref).toBe('magento-integration');
    expect(audit.events).toEqual([
      {
        id: 'id-1',
        actor: 'carol-id',
        clientId: 'aiops-web',
        action: 'connection.test',
        subject: 'magento',
        outcome: 'ok',
        correlationId: 'corr-1',
        details: { connection: 'magento', ok: true, status: 200, scopesDetectable: true },
      },
    ]);
  });

  it('CONN-7 AUD-1 a failed read reports its code and status; the audit holds no message', async () => {
    const { service, audit } = await setup({ ok: false, code: 'http_status', status: 401, durationMs: 5, message: 'upstream returned status 401' });
    const report = await service.run('magento', 'cli', 'cli', 'corr-2');
    expect(report).toEqual({
      ok: false,
      operation: 'catalog.search_products',
      status: 401,
      durationMs: 5,
      code: 'http_status',
      message: 'upstream returned status 401',
      scopes: JWT_SCOPES,
    });
    expect(audit.events[0]).toMatchObject({ actor: 'cli', outcome: 'error', details: { connection: 'magento', ok: false, status: 401, code: 'http_status', scopesDetectable: true } });
  });

  it('CONN-7 a connection without a declared test reports mapping without calling the upstream', async () => {
    const { adapter, service, audit } = await setup();
    const report = await service.run('erp', 'carol-id', 'aiops-web', 'corr-3');
    expect(report).toEqual({
      ok: false,
      operation: '',
      durationMs: 0,
      code: 'mapping',
      message: 'no connection test is declared',
      scopes: { detectable: false, source: 'none', values: [] },
    });
    expect(adapter.reads).toEqual([]);
    expect(audit.events[0]).toMatchObject({ outcome: 'error', details: { connection: 'erp', ok: false, code: 'mapping', scopesDetectable: false } });
  });

  it('CONN-7 an unknown connection reports mapping and is audited', async () => {
    const { adapter, service, audit } = await setup();
    const report = await service.run('nowhere', 'cli', 'cli', 'corr-4');
    expect(report).toMatchObject({ ok: false, code: 'mapping', message: 'connection is not configured' });
    expect(adapter.reads).toEqual([]);
    expect(audit.events[0]).toMatchObject({ details: { connection: 'nowhere', ok: false, code: 'mapping', scopesDetectable: false } });
  });

  it('CONN-7 without a stored credential the adapter is called without one', async () => {
    const { adapter, service } = await setup(OK, { stored: false });
    await service.run('magento', 'cli', 'cli', 'corr-5');
    expect(adapter.reads[0]?.credential).toBeUndefined();
  });

  it('CONN-7 uses the configuration snapshot it is given', async () => {
    const { adapter, service } = await setup();
    const report = await service.run('magento', 'cli', 'cli', 'corr-6', { ...CONFIG, connectionTests: new Map() });
    expect(report.message).toBe('no connection test is declared');
    expect(adapter.reads).toEqual([]);
  });

  it('CONN-7 a stored credential of an unknown scheme reports credential_unusable without calling the upstream', async () => {
    const { vault, adapter, service, audit } = await setup();
    await vault.put({ ref: 'magento-integration', scheme: 'kerberos', secret: { ticket: TOKEN }, actor: 'setup' });
    const report = await service.run('magento', 'cli', 'cli', 'corr-8');
    expect(report).toMatchObject({ ok: false, operation: 'catalog.search_products', code: 'credential_unusable' });
    expect(adapter.reads).toEqual([]);
    expect(audit.events[0]).toMatchObject({ outcome: 'error', details: { connection: 'magento', ok: false, code: 'credential_unusable', scopesDetectable: false } });
  });

  it.each<[string, (s: Awaited<ReturnType<typeof setup>>) => void, string]>([
    [
      'the vault lookup throws',
      ({ vault }) => {
        vault.handle = () => Promise.reject(new Error(`db down ${TOKEN}`));
      },
      'credential_unusable',
    ],
    [
      'opening the credential throws (decrypt)',
      ({ vault, adapter }) => {
        vault.handle = (ref) => Promise.resolve({ ref, scheme: 'bearer', open: () => Promise.reject(new Error(`bad tag ${TOKEN}`)) });
        // The adapter opens the credential while reading.
        adapter.read = async (input) => {
          await input.credential?.open();
          return OK;
        };
      },
      'credential_unusable',
    ],
    [
      'adapter.read throws',
      ({ adapter }) => {
        adapter.read = () => Promise.reject(new Error(`socket ${TOKEN}`));
      },
      'network',
    ],
    [
      'detectScopes throws',
      ({ adapter }) => {
        adapter.detectScopes = () => Promise.reject(new Error(`token ${TOKEN}`));
      },
      'network',
    ],
  ])('CONN-7 AUD-1 when %s the report is ok:false with a fixed message, and it is audited', async (_name, breakIt, code) => {
    const s = await setup();
    breakIt(s);
    const report = await s.service.run('magento', 'carol-id', 'aiops-web', 'corr-9');
    expect(report).toMatchObject({ ok: false, operation: 'catalog.search_products', code, scopes: { detectable: false } });
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(s.audit.events).toEqual([expect.objectContaining({ outcome: 'error', details: { connection: 'magento', ok: false, code, scopesDetectable: false } })]);
    expect(JSON.stringify(s.audit.events)).not.toContain(TOKEN);
  });

  it('SEC-3 the report and the audit never contain the secret', async () => {
    const { service, audit } = await setup();
    const report = await service.run('magento', 'carol-id', 'aiops-web', 'corr-7');
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(JSON.stringify(audit.events)).not.toContain(TOKEN);
  });
});
