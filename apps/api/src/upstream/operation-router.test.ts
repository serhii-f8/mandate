import { describe, expect, it } from 'vitest';
import type { Caller, InvocationRequest, InvocationResult, ManifestDefinition, OperationDefinition, OperationInvoker, RiskClass } from '@aiops/core';
import { OperationRouter, riskNotSupportedResult } from './operation-router.js';

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
