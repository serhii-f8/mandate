import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, mcpToolHash, type McpToolDefinition } from './index.js';

const PIN_PATTERN = /^sha256:[0-9a-f]{64}$/;

const base: McpToolDefinition = {
  name: 'lookup',
  title: 'Lookup',
  description: 'Looks a thing up',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  outputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
};

describe('CONN-4 MCP tool hash', () => {
  it('CONN-4 the hash is sha256: and 64 hex digits and is stable under key order', () => {
    const reordered: McpToolDefinition = {
      annotations: { readOnlyHint: true },
      outputSchema: { type: 'object' },
      inputSchema: { required: ['id'], properties: { id: { type: 'string' } }, type: 'object' },
      description: 'Looks a thing up',
      title: 'Lookup',
      name: 'lookup',
    };
    const hash = mcpToolHash(base);
    expect(hash).toMatch(PIN_PATTERN);
    expect(mcpToolHash(reordered)).toBe(hash);
  });

  it('CONN-4 the hash changes with name, title, description, inputSchema, outputSchema and annotations', () => {
    const variants: McpToolDefinition[] = [
      { ...base, name: 'lookup2' },
      { ...base, title: 'Lookup 2' },
      { ...base, description: 'Looks another thing up' },
      { ...base, inputSchema: { type: 'object' } },
      { ...base, outputSchema: { type: 'object', properties: {} } },
      { ...base, annotations: { readOnlyHint: false } },
    ];
    const hashes = new Set([mcpToolHash(base), ...variants.map((v) => mcpToolHash(v))]);
    expect(hashes.size).toBe(7);
  });

  it('CONN-4 _meta and icons do not change the hash', () => {
    const withExtras = { ...base, _meta: { 'x/y': 1 }, icons: [{ src: 'https://example.invalid/i.png' }] } as unknown as McpToolDefinition;
    expect(mcpToolHash(withExtras)).toBe(mcpToolHash(base));
  });

  it('CONN-4 absent title and title null hash the same; the format tag is part of the hash', () => {
    const expected =
      'sha256:' +
      createHash('sha256')
        .update(
          '{"annotations":null,"description":null,"format":"aiops.mcp-tool.v1","inputSchema":{"type":"object"},"name":"echo","outputSchema":null,"title":null}',
        )
        .digest('hex');
    expect(mcpToolHash({ name: 'echo', inputSchema: { type: 'object' } })).toBe(expected);
    const withNullTitle = { name: 'echo', title: null, inputSchema: { type: 'object' } } as unknown as McpToolDefinition;
    expect(mcpToolHash(withNullTitle)).toBe(expected);
  });

  it('CONN-4 canonicalJson rejects non-finite numbers and non-plain objects', () => {
    expect(canonicalJson({ b: [1, 'x', true, null], a: { d: 2, c: 1 } })).toBe('{"a":{"c":1,"d":2},"b":[1,"x",true,null]}');
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError);
    expect(() => canonicalJson(new Map())).toThrow(TypeError);
    expect(() => mcpToolHash({ name: 'x', inputSchema: { type: 'object', max: Number.NaN } })).toThrow(TypeError);
  });
});
