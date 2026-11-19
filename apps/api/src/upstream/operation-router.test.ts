import { describe, expect, it } from 'vitest';
import { createSchemaCompiler, loadConfigurationSources, type PinEvaluation, type PinState } from '@aiops/config';
import type { ReadAdapter } from '@aiops/connector-sdk';
import { READ_RESULT_TEXT } from '@aiops/core';
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
import type { UpstreamToolView } from '@aiops/upstream';
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

/** No MCP binding: the risk routing cases run under an HTTP-only configuration. */
const HTTP_ONLY = await loadConfigurationSources([{ file: 'connections.yaml', text: 'version: 1\nconnections: []\n' }]);
if (!HTTP_ONLY.ok) throw new Error(JSON.stringify(HTTP_ONLY.issues));
const HTTP_CONFIGURATION = HTTP_ONLY.configuration;

function setup() {
  const read = new Recording('read');
  const changeset = new Recording('changeset');
  return { read, changeset, router: new OperationRouter({ read, changeset }, { configuration: HTTP_CONFIGURATION }) };
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

  it('POL-5 a destructive operation with a manifest takes the change-set path', async () => {
    const { router, read, changeset } = setup();
    expect((await router.invoke({ operation: operation('destructive', MANIFEST), args: {}, caller })).text).toBe('changeset');
    expect(changeset.seen).toEqual(['shop.destructive']);
    expect(read.seen).toEqual([]);
  });

  it.each([
    ['write_opaque', undefined],
    ['destructive', undefined],
  ] as const)('CS-1 EXE-4 an opaque %s operation (manifest %s) takes the change-set path', async (risk, manifest) => {
    const { router, read, changeset } = setup();
    expect((await router.invoke({ operation: operation(risk, manifest), args: {}, caller })).text).toBe('changeset');
    expect(changeset.seen).toEqual([`shop.${risk}`]);
    expect(read.seen).toEqual([]);
  });

  it('MCP-4 a write operation without a manifest is refused with a fixed text and runs nothing (fail closed)', async () => {
    const { router, read, changeset } = setup();
    const result = await router.invoke({ operation: operation('write'), args: {}, caller });
    expect(result).toEqual({
      isError: true,
      text: 'shop.write cannot run: write operations are not supported yet.',
      auditDetails: { operation: 'shop.write', connection: 'shop', errorCode: 'risk_not_supported' },
    });
    expect(result).toEqual(riskNotSupportedResult(operation('write')));
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

const MCP_PIN = `sha256:${'a'.repeat(64)}`;
const MCP_SOURCES = [
  {
    file: 'connections.yaml',
    text: `version: 1
connections:
  - { id: tools, adapter: mcp, mcp_url: http://tools.example.test/mcp }
`,
  },
  {
    file: 'operations.yaml',
    text: `version: 1
operations:
  - id: tools.echo
    connection: tools
    risk: read
    description: Echo.
    upstream: { tool: echo, pin: '${MCP_PIN}' }
`,
  },
];

const DERIVED = { type: 'object' };
/** What the monitor answers for a usable pin: `ok` with the derived schema and its validator. */
const OK_EVALUATION: PinEvaluation = { state: 'ok', liveHash: MCP_PIN, inputSchema: DERIVED, validator: createSchemaCompiler()(DERIVED) };

/** A view that answers one fixed evaluation for every MCP-backed operation. */
function fixedView(state: PinState | PinEvaluation, liveHash: string | null = MCP_PIN): UpstreamToolView & { viewed: string[] } {
  const viewed: string[] = [];
  const evaluation: PinEvaluation = typeof state === 'string' ? (state === 'ok' ? OK_EVALUATION : { state, liveHash }) : state;
  return {
    viewed,
    view: (_configuration, operationId) => {
      viewed.push(operationId);
      return evaluation;
    },
    current: () => Promise.resolve(evaluation),
    touch: () => undefined,
  };
}

async function mcpSetup(state: PinState | PinEvaluation | undefined) {
  const loaded = await loadConfigurationSources(MCP_SOURCES);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  const configuration = loaded.configuration;
  const op = configuration.policy.operations.find((o) => o.id === 'tools.echo');
  if (op === undefined) throw new Error('fixture has no MCP operation');
  const read = new Recording('read');
  const changeset = new Recording('changeset');
  const view = state === undefined ? undefined : fixedView(state);
  const router = new OperationRouter({ read, changeset }, { configuration, ...(view === undefined ? {} : { upstreamTools: view }) });
  return { router, read, changeset, op, view };
}

describe('CONN-4 refusal after policy', () => {
  it('CONN-4 a changed tool is refused as upstream_changed with the fixed text and no upstream call', async () => {
    const { router, read, changeset, op } = await mcpSetup('changed');
    const result = await router.invoke({ operation: op, args: {}, caller });
    expect(result).toEqual({
      isError: true,
      text: READ_RESULT_TEXT.errors.upstream_changed('tools.echo'),
      auditDetails: { operation: 'tools.echo', connection: 'tools', errorCode: 'upstream_changed', pinState: 'changed' },
    });
    expect(result.text).toBe(
      'tools.echo cannot run: its upstream tool changed since it was reviewed; an operator must review it and record the new pin.',
    );
    expect([...read.seen, ...changeset.seen]).toEqual([]);
  });

  it('CONN-4 a missing tool is refused as upstream_changed', async () => {
    const { router, read, op } = await mcpSetup('missing');
    const result = await router.invoke({ operation: op, args: {}, caller });
    expect(result.auditDetails).toEqual({ operation: 'tools.echo', connection: 'tools', errorCode: 'upstream_changed', pinState: 'missing' });
    expect(read.seen).toEqual([]);
  });

  it.each(['unverified', 'schema_invalid'] as const)('CONN-4 a %s tool is refused as upstream_unavailable', async (state) => {
    const { router, read, op } = await mcpSetup(state);
    const result = await router.invoke({ operation: op, args: {}, caller });
    expect(result).toEqual({
      isError: true,
      text: READ_RESULT_TEXT.errors.upstream_unavailable('tools.echo'),
      auditDetails: { operation: 'tools.echo', connection: 'tools', errorCode: 'upstream_unavailable', pinState: state },
    });
    expect(result.text).toBe('tools.echo cannot run: its upstream tool could not be verified right now.');
    expect(read.seen).toEqual([]);
  });

  it('CONN-4 an ok tool takes the read path', async () => {
    const { router, read, op, view } = await mcpSetup('ok');
    expect((await router.invoke({ operation: op, args: {}, caller })).text).toBe('read');
    expect(read.seen).toEqual(['tools.echo']);
    expect(view?.viewed).toEqual(['tools.echo']);
  });

  it('CONN-4 without a tool view an MCP-backed operation is refused as upstream_unavailable (fail closed)', async () => {
    const { router, read, op } = await mcpSetup(undefined);
    const result = await router.invoke({ operation: op, args: {}, caller });
    expect(result.auditDetails).toEqual({ operation: 'tools.echo', connection: 'tools', errorCode: 'upstream_unavailable', pinState: 'unverified' });
    expect(read.seen).toEqual([]);
  });

  it('CONN-4 an ok view without a derived schema or validator is refused as schema_invalid (fail closed)', async () => {
    const { router, read, op } = await mcpSetup({ state: 'ok', liveHash: MCP_PIN });
    const result = await router.invoke({ operation: op, args: {}, caller });
    expect(result.auditDetails).toEqual({ operation: 'tools.echo', connection: 'tools', errorCode: 'upstream_unavailable', pinState: 'schema_invalid' });
    expect(read.seen).toEqual([]);
  });

  it('CONN-4 a write_opaque MCP-backed operation is refused by its pin before its risk class', async () => {
    const { router, op } = await mcpSetup('changed');
    const result = await router.invoke({ operation: { ...op, risk: 'write_opaque' }, args: {}, caller });
    expect(result.auditDetails?.errorCode).toBe('upstream_changed');
  });

  it('CONN-4 an HTTP-bound operation is not asked about pins', async () => {
    const loaded = await loadConfigurationSources(Object.entries(WIRING_SOURCES).map(([file, text]) => ({ file, text })));
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    const read = new Recording('read');
    const view = fixedView('changed');
    const router = new OperationRouter({ read, changeset: new Recording('changeset') }, { configuration: loaded.configuration, upstreamTools: view });
    const op = loaded.configuration.policy.operations.find((o) => o.id === 'shop.get_products');
    if (op === undefined) throw new Error('fixture has no read operation');
    expect((await router.invoke({ operation: op, args: {}, caller })).text).toBe('read');
    expect(view.viewed).toEqual([]);
  });
});
