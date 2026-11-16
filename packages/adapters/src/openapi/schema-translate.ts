/**
 * OpenAPI schema objects (Swagger 2.0, OAS 3.0, OAS 3.1) to JSON Schema 2020-12 that Ajv
 * accepts in strict mode (CONN-2, ADR 0018 decision 3).
 *
 * Only keywords JSON Schema 2020-12 defines are kept, each with a value of the right
 * shape; everything else (`example`, `xml`, `externalDocs`, `discriminator`, `x-*`,
 * Swagger's `collectionFormat`, ...) is dropped. Strict mode also demands that a
 * type-specific keyword (`minimum`, `properties`, ...) sits next to a matching `type`
 * and rejects union types other than `[t, "null"]`, so the type is inferred where it is
 * missing, keywords for other types are dropped, and a multi-type schema becomes `anyOf`.
 * Local `$ref`s are inlined, translated; circular or deeper than {@link MAX_REF_DEPTH}
 * becomes `{}`. Derived schemas may be looser than the spec; the upstream stays the
 * business validator.
 */
import { formatNames } from 'ajv-formats/dist/formats.js';
import type { SpecIssue } from '@aiops/connector-sdk';

export const MAX_REF_DEPTH = 8;

export interface TranslateContext {
  /** Returns the value a local `$ref` (`#/...`) points at, or `undefined`. */
  resolve(ref: string): unknown;
  /** Number of `$ref`s already followed on this branch. */
  depth: number;
  /** JSON pointer of `schema` in the document, for issues. */
  at?: readonly (string | number)[];
  /** Receives external or unresolvable `$ref`s. */
  issues?: SpecIssue[];
  /** `$ref`s being expanded on this branch (cycle detection). */
  seen?: readonly string[];
}

type Schema = Record<string, unknown>;
type Path = readonly (string | number)[];
type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
type Group = 'number' | 'string' | 'array' | 'object';

const JSON_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);
const KNOWN_FORMATS: ReadonlySet<string> = new Set(formatNames);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidPattern(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    new RegExp(value, 'u');
    return true;
  } catch {
    return false;
  }
}

/** `#/definitions/a~1b` → `['definitions', 'a/b']`. */
export function refToPath(ref: string): string[] {
  const pointer = ref.startsWith('#') ? ref.slice(1) : ref;
  if (pointer === '') return [];
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Not percent-encoded; use the segment as written.
      }
      return decoded.replace(/~1/g, '/').replace(/~0/g, '~');
    });
}

function report(ctx: TranslateContext, path: Path, message: string): void {
  if (ctx.issues === undefined) return;
  const exists = ctx.issues.some((i) => i.message === message && JSON.stringify(i.path) === JSON.stringify(path));
  if (!exists) ctx.issues.push({ path: [...path], message });
}

function sub(ctx: TranslateContext, ...segments: (string | number)[]): TranslateContext {
  return { ...ctx, at: [...(ctx.at ?? []), ...segments] };
}

export function toJsonSchema2020(schema: unknown, ctx: TranslateContext): Schema {
  if (schema === false) return { not: {} };
  if (!isPlainObject(schema)) return {};
  if (typeof schema.$ref === 'string') return translateRef(schema.$ref, ctx);

  const generic: Schema = {};
  const groups: Record<Group, Schema> = { number: {}, string: {}, array: {}, object: {} };

  for (const key of ['title', 'description', '$comment'] as const) {
    if (typeof schema[key] === 'string') generic[key] = schema[key];
  }
  for (const key of ['deprecated', 'readOnly', 'writeOnly'] as const) {
    if (typeof schema[key] === 'boolean') generic[key] = schema[key];
  }
  if (schema.default !== undefined) generic.default = schema.default;
  if (Array.isArray(schema.examples)) generic.examples = schema.examples;
  else if (schema.example !== undefined) generic.examples = [schema.example];
  if (Array.isArray(schema.enum) && schema.enum.length > 0) generic.enum = [...(schema.enum as unknown[])];
  if (schema.const !== undefined) generic.const = schema.const;
  if (typeof schema.format === 'string' && KNOWN_FORMATS.has(schema.format)) generic.format = schema.format;
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const list = schema[key];
    if (Array.isArray(list) && list.length > 0) generic[key] = list.map((s, i) => toJsonSchema2020(s, sub(ctx, key, i)));
  }
  if (isPlainObject(schema.not) || typeof schema.not === 'boolean') generic.not = toJsonSchema2020(schema.not, sub(ctx, 'not'));

  translateNumber(schema, groups.number);
  translateString(schema, groups.string);
  translateArray(schema, groups.array, ctx);
  translateObject(schema, groups.object, ctx);

  const declared = declaredTypes(schema.type);
  const nullable = schema.nullable === true;
  const present = (Object.keys(groups) as Group[]).filter((g) => Object.keys(groups[g]).length > 0);
  const nonNull: JsonType[] =
    declared === undefined ? present : declared.filter((t): t is Exclude<JsonType, 'null'> => t !== 'null');
  const hasNull = (declared?.includes('null') ?? false) || (nullable && nonNull.length > 0);

  if (nullable && Array.isArray(generic.enum) && !generic.enum.includes(null)) generic.enum.push(null);

  const branch = (t: JsonType): Schema => ({ type: t, ...keywordsFor(t, groups) });
  if (nonNull.length > 1) {
    const anyOf = [...nonNull.map(branch), ...(hasNull ? [{ type: 'null' }] : [])];
    if (generic.anyOf === undefined) return { ...generic, anyOf };
    return { ...generic, allOf: [...((generic.allOf as Schema[] | undefined) ?? []), { anyOf }] };
  }
  const [only] = nonNull;
  if (only === undefined) return hasNull ? { ...generic, type: 'null' } : generic;
  return { ...generic, type: hasNull ? [only, 'null'] : only, ...keywordsFor(only, groups) };
}

function declaredTypes(type: unknown): JsonType[] | undefined {
  const list = typeof type === 'string' ? [type] : Array.isArray(type) ? type : [];
  const valid = [...new Set(list.filter((t): t is JsonType => typeof t === 'string' && JSON_TYPES.has(t)))];
  return valid.length > 0 ? valid : undefined;
}

function keywordsFor(type: JsonType, groups: Record<Group, Schema>): Schema {
  switch (type) {
    case 'number':
    case 'integer':
      return groups.number;
    case 'string':
      return groups.string;
    case 'array':
      return groups.array;
    case 'object':
      return groups.object;
    default:
      return {};
  }
}

function translateRef(ref: string, ctx: TranslateContext): Schema {
  const at = [...(ctx.at ?? []), '$ref'];
  if (!ref.startsWith('#')) {
    report(ctx, at, 'external $ref is not supported');
    return {};
  }
  const seen = ctx.seen ?? [];
  if (ctx.depth >= MAX_REF_DEPTH || seen.includes(ref)) return {};
  const target = ctx.resolve(ref);
  if (target === undefined) {
    report(ctx, at, '$ref does not resolve in the document');
    return {};
  }
  return toJsonSchema2020(target, { ...ctx, depth: ctx.depth + 1, seen: [...seen, ref], at: refToPath(ref) });
}

function translateNumber(schema: Schema, out: Schema): void {
  if (isFiniteNumber(schema.multipleOf) && schema.multipleOf > 0) out.multipleOf = schema.multipleOf;
  for (const [bound, exclusive] of [
    ['minimum', 'exclusiveMinimum'],
    ['maximum', 'exclusiveMaximum'],
  ] as const) {
    const limit = schema[bound];
    const flag = schema[exclusive];
    if (isFiniteNumber(flag)) out[exclusive] = flag;
    if (!isFiniteNumber(limit)) continue;
    // OAS 3.0 / Swagger 2.0 boolean form: `exclusiveMinimum: true` makes `minimum` exclusive.
    if (flag === true) out[exclusive] = limit;
    else out[bound] = limit;
  }
}

function translateString(schema: Schema, out: Schema): void {
  if (isNonNegativeInteger(schema.minLength)) out.minLength = schema.minLength;
  if (isNonNegativeInteger(schema.maxLength)) out.maxLength = schema.maxLength;
  if (isValidPattern(schema.pattern)) out.pattern = schema.pattern;
  if (typeof schema.contentEncoding === 'string') out.contentEncoding = schema.contentEncoding;
  if (typeof schema.contentMediaType === 'string') out.contentMediaType = schema.contentMediaType;
}

function translateArray(schema: Schema, out: Schema, ctx: TranslateContext): void {
  // Draft-04 tuple form (`items: [...]`) is dropped: strict tuples need exact bounds.
  if (isPlainObject(schema.items) || typeof schema.items === 'boolean') out.items = toJsonSchema2020(schema.items, sub(ctx, 'items'));
  if (isNonNegativeInteger(schema.minItems)) out.minItems = schema.minItems;
  if (isNonNegativeInteger(schema.maxItems)) out.maxItems = schema.maxItems;
  if (typeof schema.uniqueItems === 'boolean') out.uniqueItems = schema.uniqueItems;
  if (isPlainObject(schema.contains)) {
    out.contains = toJsonSchema2020(schema.contains, sub(ctx, 'contains'));
    if (isNonNegativeInteger(schema.minContains)) out.minContains = schema.minContains;
    if (isNonNegativeInteger(schema.maxContains)) out.maxContains = schema.maxContains;
  }
}

function translateObject(schema: Schema, out: Schema, ctx: TranslateContext): void {
  const properties = isPlainObject(schema.properties) ? schema.properties : undefined;
  if (properties !== undefined) {
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([name, s]) => [name, toJsonSchema2020(s, sub(ctx, 'properties', name))]),
    );
  }
  if (isPlainObject(schema.patternProperties)) {
    const entries = Object.entries(schema.patternProperties).filter(([pattern]) => isValidPattern(pattern));
    if (entries.length > 0) {
      out.patternProperties = Object.fromEntries(
        entries.map(([pattern, s]) => [pattern, toJsonSchema2020(s, sub(ctx, 'patternProperties', pattern))]),
      );
    }
  }
  if (typeof schema.additionalProperties === 'boolean') out.additionalProperties = schema.additionalProperties;
  else if (isPlainObject(schema.additionalProperties)) {
    out.additionalProperties = toJsonSchema2020(schema.additionalProperties, sub(ctx, 'additionalProperties'));
  }
  if (Array.isArray(schema.required) && properties !== undefined) {
    // Strict mode rejects `required` names without a property at the same level.
    const required = [...new Set(schema.required.filter((n): n is string => typeof n === 'string' && Object.hasOwn(properties, n)))];
    if (required.length > 0) out.required = required;
  }
  if (isNonNegativeInteger(schema.minProperties)) out.minProperties = schema.minProperties;
  if (isNonNegativeInteger(schema.maxProperties)) out.maxProperties = schema.maxProperties;
  if (isPlainObject(schema.propertyNames)) out.propertyNames = toJsonSchema2020(schema.propertyNames, sub(ctx, 'propertyNames'));
}
