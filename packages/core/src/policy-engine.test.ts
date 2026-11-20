import { describe, expect, it } from 'vitest';
import type { Caller } from './caller.js';
import { createPolicyEngine, type EvaluationRequest } from './policy-engine.js';
import type { PolicyConfiguration } from './policy-model.js';

const objectSchema = { type: 'object' } as const;

const config: PolicyConfiguration = {
  operations: [
    { id: 'catalog.search_products', toolName: 'catalog.search_products', source: 'config', connection: 'magento', risk: 'read', description: 'Search', inputSchema: objectSchema, fieldsArg: 'fields' },
    { id: 'support.lookup_order', toolName: 'support.lookup_order', source: 'config', connection: 'magento', risk: 'read', description: 'Lookup', inputSchema: objectSchema },
  ],
  roles: [
    {
      id: 'content_manager',
      grants: [
        { operation: 'catalog.search_products', id: 'own-brands', scope: { brand: ['acme', 'globex'] }, denyFields: ['cost'] },
        { operation: 'catalog.search_products', scope: { brand: ['initech'] }, denyFields: [], allowFields: ['name'] },
      ],
    },
    { id: 'support_agent', grants: [{ operation: 'support.lookup_order', scope: {}, denyFields: [] }] },
  ],
  roleMapping: [
    { group: 'content', roles: ['content_manager'] },
    { group: 'support', roles: ['support_agent'] },
  ],
};

const engine = createPolicyEngine(config);
const content: Caller = { subject: 'alice', groups: ['content'] };
const support: Caller = { subject: 'bob', groups: ['support'] };
const nobody: Caller = { subject: 'carol', groups: [] };

function search(args: Record<string, unknown>, caller: Caller = content): ReturnType<typeof engine.evaluate> {
  return engine.evaluate({ caller, operationId: 'catalog.search_products', args });
}

describe('POL-1 deny by default', () => {
  it('denies a caller without roles', () => {
    expect(search({ brand: 'acme' }, nobody)).toEqual({ effect: 'deny', rule: 'default-deny', reason: 'no_grant', roles: [] });
  });

  it('denies an operation none of the caller roles grants', () => {
    expect(search({ brand: 'acme' }, support)).toMatchObject({ effect: 'deny', rule: 'default-deny', reason: 'no_grant', roles: ['support_agent'] });
  });

  it('denies an operation that does not exist', () => {
    expect(engine.evaluate({ caller: content, operationId: 'nope', args: {} })).toMatchObject({ effect: 'deny', rule: 'default-deny' });
  });
});

describe('POL-2 scope constraints', () => {
  it('allows a value in scope and names the grant', () => {
    expect(search({ brand: 'acme' })).toEqual({ effect: 'allow', rule: 'role:content_manager/grant:own-brands', roles: ['content_manager'] });
  });

  it('allows an array whose every element is in scope', () => {
    expect(search({ brand: ['acme', 'globex'] })).toMatchObject({ effect: 'allow' });
  });

  it('denies an array that mixes allowed and disallowed values', () => {
    expect(search({ brand: ['acme', 'umbrella'] })).toMatchObject({
      effect: 'deny',
      rule: 'role:content_manager/grant:own-brands/scope:brand',
      reason: 'out_of_scope',
      detail: 'brand',
    });
  });

  it('denies an empty array', () => {
    expect(search({ brand: [] })).toMatchObject({ effect: 'deny', reason: 'out_of_scope' });
  });

  it('denies when the scope argument is missing', () => {
    expect(search({})).toMatchObject({ effect: 'deny', reason: 'scope_argument_missing', rule: 'role:content_manager/grant:own-brands/scope:brand' });
  });

  it('falls through to a later grant and names it by index', () => {
    expect(search({ brand: 'initech', fields: ['name'] })).toMatchObject({ effect: 'allow', rule: 'role:content_manager/grant:1' });
  });

  it('compares strictly: a number does not match its string form', () => {
    const numeric = createPolicyEngine({
      ...config,
      roles: [{ id: 'content_manager', grants: [{ operation: 'catalog.search_products', scope: { brand: ['1'] }, denyFields: [] }] }],
    });
    expect(numeric.evaluate({ caller: content, operationId: 'catalog.search_products', args: { brand: 1 } })).toMatchObject({
      effect: 'deny',
      reason: 'out_of_scope',
    });
  });

  it('denies an object given for a scope argument', () => {
    expect(search({ brand: { $in: ['acme'] } })).toMatchObject({ effect: 'deny', reason: 'out_of_scope' });
  });
});

describe('POL-3 denied fields', () => {
  it('denies a call touching a denied field', () => {
    expect(search({ brand: 'acme', fields: ['name', 'cost'] })).toMatchObject({
      effect: 'deny',
      rule: 'role:content_manager/grant:own-brands/deny_fields',
      reason: 'denied_field',
      detail: 'cost',
    });
  });

  it('reads touched fields from the keys of an object argument', () => {
    expect(search({ brand: 'acme', fields: { cost: 1 } })).toMatchObject({ effect: 'deny', reason: 'denied_field' });
  });

  it('denies a field outside the allow-list', () => {
    const allowOnly = createPolicyEngine({
      ...config,
      roles: [{ id: 'content_manager', grants: [{ operation: 'catalog.search_products', scope: {}, denyFields: [], allowFields: ['name'] }] }],
    });
    expect(allowOnly.evaluate({ caller: content, operationId: 'catalog.search_products', args: { fields: ['price'] } })).toMatchObject({
      effect: 'deny',
      rule: 'role:content_manager/grant:0/allow_fields',
      reason: 'field_not_allowed',
      detail: 'price',
    });
  });

  it.each([
    ['an array of objects', [{ code: 'cost', value: 1 }]],
    ['a string', 'cost'],
    ['a nested array', [['cost']]],
    ['an array mixing strings and objects', ['name', { code: 'cost' }]],
  ])('denies when the fields argument is %s, since its fields cannot be read (fail closed)', (_name, fields) => {
    expect(search({ brand: 'acme', fields })).toMatchObject({
      effect: 'deny',
      rule: 'role:content_manager/grant:own-brands/deny_fields',
      reason: 'denied_field',
      detail: 'fields',
    });
  });

  it('reports the first grant first failing check when no grant passes', () => {
    expect(search({ brand: 'initech', fields: ['price'] })).toMatchObject({
      effect: 'deny',
      rule: 'role:content_manager/grant:own-brands/scope:brand',
    });
  });
});

describe('MCP-2 granted operations', () => {
  it('lists the operations of the caller roles', () => {
    expect(engine.grantedOperations(content).map((o) => o.id)).toEqual(['catalog.search_products']);
  });

  it('unions roles in configuration order', () => {
    expect(engine.grantedOperations({ subject: 'dave', groups: ['support', 'content'] }).map((o) => o.id)).toEqual([
      'catalog.search_products',
      'support.lookup_order',
    ]);
  });

  it('lists nothing for a caller without roles', () => {
    expect(engine.grantedOperations(nobody)).toEqual([]);
  });
});

describe('AUTH-4 service callers', () => {
  it('AUTH-4 POL-1 the engine grants a service caller its role only', () => {
    const withService = createPolicyEngine({ ...config, serviceAccounts: [{ clientId: 'sa', role: 'support_agent' }] });
    const sa: Caller = { subject: 'service:sa', groups: ['content'] };
    expect(withService.evaluate({ caller: sa, operationId: 'support.lookup_order', args: {} })).toMatchObject({ effect: 'allow', roles: ['support_agent'] });
    expect(withService.evaluate({ caller: sa, operationId: 'catalog.search_products', args: { brand: 'acme' } })).toMatchObject({
      effect: 'deny',
      reason: 'no_grant',
      roles: ['support_agent'],
    });
    expect(withService.grantedOperations(sa).map((o) => o.id)).toEqual(['support.lookup_order']);
  });
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('POL-7 dry evaluation', () => {
  it('is repeatable and does not touch its input', () => {
    const request: EvaluationRequest = deepFreeze({ caller: content, operationId: 'catalog.search_products', args: { brand: ['acme'], fields: ['name'] } });
    const first = engine.evaluate(request);
    expect(engine.evaluate(request)).toEqual(first);
  });
});

describe('NFR-6 evaluation from in-memory configuration', () => {
  it('needs nothing but the configuration and is fast', () => {
    const started = performance.now();
    for (let i = 0; i < 10_000; i++) search({ brand: i % 2 === 0 ? 'acme' : 'umbrella', fields: ['name'] });
    expect(performance.now() - started).toBeLessThan(200);
  });
});
