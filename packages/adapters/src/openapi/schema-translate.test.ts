import { describe, expect, it } from 'vitest';
import type { SpecIssue } from '@aiops/connector-sdk';
import { strictAjv } from '../../test/strict-ajv.js';
import { MAX_REF_DEPTH, toJsonSchema2020 } from './schema-translate.js';

const noRefs = { resolve: (): unknown => undefined, depth: 0 };

describe('CONN-2 OpenAPI schema translation to JSON Schema 2020-12', () => {
  it('CONN-2 translates nullable, example, xml, x-*, discriminator and boolean exclusiveMinimum so Ajv strict compiles it', () => {
    const source = {
      type: 'object',
      discriminator: { propertyName: 'kind' },
      xml: { name: 'Thing' },
      externalDocs: { url: 'https://docs.example.test' },
      'x-foo': 1,
      required: ['kind', 'name', 'ghost'],
      properties: {
        kind: { type: 'string', enum: ['a', 'b'], nullable: true },
        name: { type: 'string', nullable: true, example: 'widget', 'x-bar': true },
        price: { type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 10, exclusiveMaximum: false },
        'x-literal-property': { type: 'string' },
      },
    };
    const out = toJsonSchema2020(source, noRefs);
    expect(out).toEqual({
      type: 'object',
      required: ['kind', 'name'],
      properties: {
        kind: { type: ['string', 'null'], enum: ['a', 'b', null] },
        name: { type: ['string', 'null'], examples: ['widget'] },
        price: { type: 'number', exclusiveMinimum: 0, maximum: 10 },
        'x-literal-property': { type: 'string' },
      },
    });
    const validate = strictAjv().compile(out);
    expect(validate({ kind: null, name: null })).toBe(true);
    expect(validate({ kind: 'a', name: 'n', price: 0 })).toBe(false);
  });

  it('CONN-2 infers the type a type-specific keyword needs and drops keywords for another type', () => {
    expect(toJsonSchema2020({ properties: { a: { minimum: 1 } } }, noRefs)).toEqual({
      type: 'object',
      properties: { a: { type: 'number', minimum: 1 } },
    });
    expect(toJsonSchema2020({ type: 'string', minimum: 1, maxLength: 3 }, noRefs)).toEqual({ type: 'string', maxLength: 3 });
    expect(toJsonSchema2020({ items: { type: 'string' } }, noRefs)).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('CONN-2 turns a multi-type schema into anyOf so strict mode accepts it', () => {
    const out = toJsonSchema2020({ type: ['string', 'integer', 'null'], minLength: 2, minimum: 3 }, noRefs);
    expect(out).toEqual({
      anyOf: [{ type: 'string', minLength: 2 }, { type: 'integer', minimum: 3 }, { type: 'null' }],
    });
    const validate = strictAjv().compile(out);
    expect(validate('ab')).toBe(true);
    expect(validate(4)).toBe(true);
    expect(validate(null)).toBe(true);
    expect(validate(1)).toBe(false);
  });

  it('CONN-2 keeps formats ajv-formats knows and drops unknown formats and invalid patterns', () => {
    expect(toJsonSchema2020({ type: 'integer', format: 'int64' }, noRefs)).toEqual({ type: 'integer', format: 'int64' });
    expect(toJsonSchema2020({ type: 'string', format: 'magento-sku' }, noRefs)).toEqual({ type: 'string' });
    expect(toJsonSchema2020({ type: 'string', pattern: '(' }, noRefs)).toEqual({ type: 'string' });
  });

  it('CONN-2 maps Swagger 2.0 type file and tuple items to a loose schema', () => {
    expect(toJsonSchema2020({ type: 'file' }, noRefs)).toEqual({});
    expect(toJsonSchema2020({ type: 'array', items: [{ type: 'string' }] }, noRefs)).toEqual({ type: 'array' });
  });

  it('CONN-2 inlines local $refs translated and stops at circular references and depth', () => {
    const defs: Record<string, unknown> = {
      '#/definitions/Node': { type: 'object', properties: { child: { $ref: '#/definitions/Node' }, x: { nullable: true, type: 'string' } } },
    };
    const ctx = { resolve: (ref: string): unknown => defs[ref], depth: 0 };
    const out = toJsonSchema2020({ $ref: '#/definitions/Node' }, ctx);
    expect(out).toEqual({ type: 'object', properties: { child: {}, x: { type: ['string', 'null'] } } });

    const chain: Record<string, unknown> = {};
    for (let i = 0; i < 20; i += 1) chain[`#/definitions/L${i}`] = { type: 'object', properties: { next: { $ref: `#/definitions/L${i + 1}` } } };
    let node = toJsonSchema2020({ $ref: '#/definitions/L0' }, { resolve: (ref: string): unknown => chain[ref], depth: 0 });
    let levels = 0;
    while (node.properties !== undefined) {
      node = (node.properties as { next: Record<string, unknown> }).next;
      levels += 1;
    }
    expect(levels).toBe(MAX_REF_DEPTH);
    expect(node).toEqual({});
  });

  it('CONN-2 reports an external $ref as an issue naming its pointer and translates it to {}', () => {
    const issues: SpecIssue[] = [];
    const out = toJsonSchema2020(
      { type: 'object', properties: { a: { $ref: 'other.json#/x' } } },
      { ...noRefs, at: ['definitions', 'Thing'], issues },
    );
    expect(out).toEqual({ type: 'object', properties: { a: {} } });
    expect(issues).toEqual([{ path: ['definitions', 'Thing', 'properties', 'a', '$ref'], message: 'external $ref is not supported' }]);
  });

  it('CONN-2 reports a local $ref that does not resolve', () => {
    const issues: SpecIssue[] = [];
    expect(toJsonSchema2020({ $ref: '#/definitions/Missing' }, { ...noRefs, issues })).toEqual({});
    expect(issues).toEqual([{ path: ['$ref'], message: '$ref does not resolve in the document' }]);
  });
});
