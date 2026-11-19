import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfigurationDirectory, loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import { mcpToolHash, type McpToolDefinition, type ToolListOutcome } from '@aiops/connector-sdk';
import { FakeResolver } from '@aiops/testing';
import { explainCall, formatExplain, type ExplainInput } from './explain.js';

const DEV_CONFIG = fileURLToPath(new URL('../../../../deploy/config', import.meta.url));
const REPO_PRESETS = fileURLToPath(new URL('../../../../presets', import.meta.url));

const SEARCH_ARGS = { brand: 'acme', fields: ['sku'] };
const UPDATE_ARGS = { brand: 'acme', skus: ['A-1'], changes: { name: 'New name' } };

let configuration: LoadedConfiguration;
beforeAll(async () => {
  const result = await loadConfigurationDirectory(DEV_CONFIG, { presetDirs: [REPO_PRESETS] });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  configuration = result.configuration;
});

const explain = (input: Partial<ExplainInput> & Pick<ExplainInput, 'operationId' | 'groups'>, config?: LoadedConfiguration): readonly string[] =>
  formatExplain(explainCall(config ?? configuration, { args: {}, records: 1, ...input }));

describe('POL-7 explain', () => {
  it('POL-7 an allowed read prints effect allow, the rule and roles, and no approval line', () => {
    expect(explain({ operationId: 'catalog.search_products', groups: ['content'], args: SEARCH_ARGS })).toEqual([
      'effect: allow',
      'rule: role:content_manager/grant:own-brands',
      'roles: content_manager',
      'reason: -',
      'detail: -',
    ]);
  });

  it('POL-7 a denied call prints the deny reason and detail', () => {
    expect(explain({ operationId: 'catalog.search_products', groups: ['support'], args: SEARCH_ARGS })).toEqual([
      'effect: deny',
      'rule: default-deny',
      'roles: support_agent',
      'reason: no_grant',
      'detail: -',
    ]);
    expect(explain({ operationId: 'catalog.search_products', groups: ['content'], args: { ...SEARCH_ARGS, brand: 'initech' } })).toEqual([
      'effect: deny',
      'rule: role:content_manager/grant:own-brands/scope:brand',
      'roles: content_manager',
      'reason: out_of_scope',
      'detail: brand',
    ]);
    expect(explain({ operationId: 'catalog.search_products', groups: [], args: SEARCH_ARGS })).toEqual([
      'effect: deny',
      'rule: default-deny',
      'roles: -',
      'reason: no_grant',
      'detail: -',
    ]);
  });

  it('POL-7 an unknown operation skips the argument check and is denied as unknown_tool', () => {
    expect(explain({ operationId: 'catalog.no_such_operation', groups: ['content'], args: { any: 1 } })).toEqual([
      'effect: deny',
      'rule: default-deny',
      'roles: content_manager',
      'reason: unknown_tool',
      'detail: -',
    ]);
  });

  it('POL-5 POL-7 an allowed write prints the approval requirement', () => {
    const allowed = ['effect: allow', 'rule: role:content_manager/grant:own-brands-content', 'roles: content_manager', 'reason: -', 'detail: -'];
    const input = { operationId: 'catalog.update_content', groups: ['content'], args: UPDATE_ARGS };
    expect(explain(input)).toEqual([...allowed, 'approval: not required']);
    expect(explain({ ...input, records: 25 })).toEqual([...allowed, 'approval: not required']);
    expect(explain({ ...input, records: 26 })).toEqual([...allowed, 'approval: required: steps content_lead; reason above_threshold']);
    const twoSteps = { ...configuration, approval: new Map([['content_manager', { required: 'always' as const, steps: ['content_lead', 'integration_admin'], allowWidget: false }]]) };
    expect(explain(input, twoSteps).at(-1)).toBe('approval: required: steps content_lead, integration_admin; reason role_always');
    // A role without approval steps: approval is required by default and cannot be routed.
    expect(explain(input, { ...configuration, approval: new Map() }).at(-1)).toBe('approval: unroutable; reason default');
  });

  it('MCP-3 POL-7 arguments are checked against the input schema before the policy', () => {
    // support has no grant: the schema answers first, as on a real call.
    const lines = explain({ operationId: 'catalog.search_products', groups: ['support'], args: { brand: 'acme' } });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('effect: invalid_arguments');
    expect(lines[1]).toMatch(/^message: arguments must have required property 'fields'$/);
    expect(explainCall(configuration, { operationId: 'catalog.search_products', groups: ['content'], args: { brand: 'acme' }, records: 1 })).toMatchObject({
      kind: 'invalid_arguments',
    });
  });
});

const LOOKUP: McpToolDefinition = { name: 'lookup', inputSchema: { type: 'object', properties: { key: { type: 'string' } } } };
const MCP_SOURCES = [
  {
    file: 'config.yaml',
    text: `version: 1
connections:
  - { id: tools, adapter: mcp, mcp_url: https://tools.example.test/mcp }
operations:
  - id: tools.lookup
    connection: tools
    risk: read
    description: Look up a record by key.
    upstream: { tool: lookup, pin: ${mcpToolHash(LOOKUP)} }
roles:
  - id: viewer
    grants: [{ operation: tools.lookup }]
role_mapping:
  - { group: viewers, roles: [viewer] }
`,
  },
];

async function mcpConfiguration(list: ToolListOutcome): Promise<LoadedConfiguration> {
  const result = await loadConfigurationSources(MCP_SOURCES, { resolver: new FakeResolver({}, {}, { tools: list }) });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.configuration;
}

const listedTools = (...tools: McpToolDefinition[]): ToolListOutcome => ({ ok: true, tools: tools.map((definition) => ({ definition, hash: mcpToolHash(definition) })), dropped: 0, durationMs: 1 });

describe('CONN-4 explain of an MCP-backed operation', () => {
  it('CONN-4 explain reports the pin state of an MCP-backed operation', async () => {
    const input = { operationId: 'tools.lookup', groups: ['viewers'], args: { key: 'k1' } };
    const ok = explain(input, await mcpConfiguration(listedTools(LOOKUP)));
    expect(ok.slice(0, 1)).toEqual(['effect: allow']);
    expect(ok.slice(4)).toEqual(['detail: -', 'pin: ok']);
    const changed = explain(input, await mcpConfiguration(listedTools({ ...LOOKUP, description: 'changed' })));
    expect(changed.at(-1)).toBe('pin: changed');
    const missing = explain(input, await mcpConfiguration(listedTools()));
    expect(missing.at(-1)).toBe('pin: missing');
    const unverified = explain(input, await mcpConfiguration({ ok: false, code: 'network', durationMs: 1, message: 'down' }));
    expect(unverified.at(-1)).toBe('pin: unverified');
    // A denied call still states the pin; an HTTP-backed operation has no pin line.
    expect(explain({ ...input, groups: [] }, await mcpConfiguration(listedTools(LOOKUP))).slice(-2)).toEqual(['detail: -', 'pin: ok']);
    expect(explain({ operationId: 'catalog.search_products', groups: ['content'], args: SEARCH_ARGS }).some((l) => l.startsWith('pin:'))).toBe(false);
  });
});
