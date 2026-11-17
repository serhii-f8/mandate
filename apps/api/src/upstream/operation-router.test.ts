import { describe, expect, it } from 'vitest';
import { loadConfigurationSources } from '@aiops/config';
import type { ReadAdapter } from '@aiops/connector-sdk';
import type {
  Caller,
  CredentialVault,
  InvocationRequest,
  InvocationResult,
  ManifestDefinition,
  OperationDefinition,
  OperationInvoker,
  RiskClass,
} from '@aiops/core';
import { InMemoryChangeSetRepository, InMemoryTaskRepository } from '@aiops/testing';
import { OperationRouter, operationInvokers, riskNotSupportedResult } from './operation-router.js';

const caller: Caller = { subject: 'alice-id', groups: [] };

const MANIFEST: ManifestDefinition = {
  idField: 'sku',
  idsArg: 'skus',
  valuesArg: 'changes',
  fields: ['name'],
  requiredFields: [],
  scopeArgs: {},
  readBefore: { operation: 'shop.get', idsArg: 'skus', args: {} },
  batchSize: 100,
  maxTargets: 10_000,
  rollback: { strategy: 'none' },
};

function operation(risk: RiskClass, manifest?: ManifestDefinition): OperationDefinition {
  return {
    id: `shop.${risk}`,
    toolName: `shop.${risk}`,
    source: 'config',
    connection: 'shop',
    risk,
    description: 'x',
    inputSchema: { type: 'object' },
    ...(manifest === undefined ? {} : { manifest }),
  };
}

class Recording implements OperationInvoker {
  readonly seen: string[] = [];
  constructor(private readonly name: string) {}
  invoke(req: InvocationRequest): Promise<InvocationResult> {
    this.seen.push(req.operation.id);
    return Promise.resolve({ text: this.name });
  }
}

function setup() {
  const read = new Recording('read');
  const changeset = new Recording('changeset');
  return { read, changeset, router: new OperationRouter({ read, changeset }) };
}

describe('MCP-4 CS-1 operation routing by risk', () => {
  it('MCP-4 routes read operations to the direct read path', async () => {
    const { router, read, changeset } = setup();
    expect((await router.invoke({ operation: operation('read'), args: {}, caller })).text).toBe('read');
    expect(read.seen).toEqual(['shop.read']);
    expect(changeset.seen).toEqual([]);
  });

  it('CS-1 routes write operations with a manifest to change-set preparation', async () => {
    const { router, read, changeset } = setup();
    expect((await router.invoke({ operation: operation('write', MANIFEST), args: {}, caller })).text).toBe('changeset');
    expect(changeset.seen).toEqual(['shop.write']);
    expect(read.seen).toEqual([]);
  });

  it.each([
    ['write_opaque', undefined],
    ['destructive', undefined],
    ['destructive', MANIFEST],
  ] as const)('MCP-4 refuses %s operations (manifest %s) with a fixed text and runs nothing', async (risk, manifest) => {
    const { router, read, changeset } = setup();
    const result = await router.invoke({ operation: operation(risk, manifest), args: {}, caller });
    expect(result).toEqual({
      isError: true,
      text: `shop.${risk} cannot run: ${risk} operations are not supported yet.`,
      auditDetails: { operation: `shop.${risk}`, connection: 'shop', errorCode: 'risk_not_supported' },
    });
    expect(result).toEqual(riskNotSupportedResult(operation(risk, manifest)));
    expect([...read.seen, ...changeset.seen]).toEqual([]);
  });
});

const WIRING_SOURCES = {
  'connections.yaml': `version: 1
connections:
  - { id: shop, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: shop-key, auth: { scheme: bearer } }
`,
  'operations.yaml': `version: 1
operations:
  - id: shop.get_products
    connection: shop
    risk: read
    description: Products by SKU.
    upstream: { method: GET, path: /V1/products, query: { skus: { arg: skus, join: ',' } }, response: { items: items, fields_from_arg: fields } }
    input_schema:
      type: object
      properties: { skus: { type: array, items: { type: string } }, fields: { type: array, items: { type: string } } }
      required: [skus, fields]
    fields_arg: fields
  - id: shop.update_content
    connection: shop
    risk: write
    description: Update content.
    upstream: { method: POST, path: /async/bulk/V1/products }
    input_schema:
      type: object
      properties:
        skus: { type: array, items: { type: string } }
        changes: { type: object, properties: { name: { type: string } }, additionalProperties: false }
      required: [skus, changes]
    manifest:
      id_field: sku
      ids_arg: skus
      values_arg: changes
      fields: [name]
      read_before: { operation: shop.get_products, ids_arg: skus }
      rollback: { strategy: none }
`,
};

/** Nothing upstream is reached here: the spy starter never runs preparation. */
const UNREACHABLE_VAULT: CredentialVault = {
  put: () => Promise.reject(new Error('unreachable')),
  describe: () => Promise.reject(new Error('unreachable')),
  handle: () => Promise.reject(new Error('unreachable')),
};
const UNREACHABLE_ADAPTER: ReadAdapter = {
  read: () => Promise.reject(new Error('unreachable')),
  detectScopes: () => Promise.reject(new Error('unreachable')),
};

describe('MCP-1 MCP-7 operationInvokers wiring', () => {
  it('MCP-1 passes the prepare wait and the 250 ms poll interval to the change-set path', async () => {
    const loaded = await loadConfigurationSources(Object.entries(WIRING_SOURCES).map(([file, text]) => ({ file, text })));
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    const started: string[] = [];
    const sleeps: number[] = [];
    let n = 0;
    const invokerFor = operationInvokers({
      vault: UNREACHABLE_VAULT,
      adapter: UNREACHABLE_ADAPTER,
      repository: new InMemoryChangeSetRepository(),
      tasks: new InMemoryTaskRepository(),
      starter: {
        start: (id) => {
          started.push(id);
          return Promise.resolve();
        },
      },
      prepareWaitMs: 1000,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      now: () => new Date('2026-11-17T10:00:00.000Z'),
    });
    const write = loaded.configuration.policy.operations.find((o) => o.id === 'shop.update_content');
    if (write === undefined) throw new Error('fixture has no write operation');
    const result = await invokerFor(loaded.configuration, 'corr-1').invoke({ operation: write, args: { skus: ['a'], changes: { name: 'N' } }, caller });
    const id = '00000000-0000-4000-8000-000000000001';
    expect(started).toEqual([id]);
    // 1000 ms at the default 250 ms poll interval: four sleeps, then the preparing answer.
    expect(sleeps).toEqual([250, 250, 250, 250]);
    expect(result.structured).toEqual({ changesetId: id, status: 'preparing' });
  });

  it('MCP-1 a negative prepare wait stops the wiring instead of every write call', () => {
    expect(() =>
      operationInvokers({
        vault: UNREACHABLE_VAULT,
        adapter: UNREACHABLE_ADAPTER,
        repository: new InMemoryChangeSetRepository(),
        tasks: new InMemoryTaskRepository(),
        starter: { start: () => Promise.resolve() },
        prepareWaitMs: -1,
        newId: () => 'x',
        now: () => new Date(),
      }),
    ).toThrow(/timeoutMs must not be negative/);
  });
});
