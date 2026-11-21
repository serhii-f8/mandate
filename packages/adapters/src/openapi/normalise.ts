// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * Spec loading (CONN-2, ADR 0018 decisions 1 and 2): structural validation with
 * `@seriousme/openapi-schema-validator`, then our own normaliser that reads Swagger 2.0
 * and OpenAPI 3.0/3.1 into one model. Only operations, parameters and JSON request
 * bodies are read; callbacks, links, webhooks and responses are ignored.
 *
 * Issues name the JSON pointer of the problem, never a value from the document (SEC-3).
 */
import { Validator } from '@seriousme/openapi-schema-validator';
import type { HttpMethod, SpecIssue } from '@aiops/connector-sdk';
import { isPlainObject, pushIssue, refToPath, toJsonSchema2020, type TranslateContext } from './schema-translate.js';

export interface NormalisedParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  schema: Record<string, unknown>;
}

export interface NormalisedOperation {
  operationId?: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  parameters: NormalisedParameter[];
  jsonBody?: { required: boolean; schema: Record<string, unknown> };
}

type Pointer = (string | number)[];

const MAX_VALIDATION_ISSUES = 50;
/** Schema nodes one derived input schema may inline (all parameters and the body together). */
export const MAX_SCHEMA_NODES = 2000;
const METHODS: ReadonlyMap<string, HttpMethod> = new Map([
  ['get', 'GET'],
  ['put', 'PUT'],
  ['post', 'POST'],
  ['delete', 'DELETE'],
  ['patch', 'PATCH'],
]);
/** Swagger 2.0 non-body parameters carry their schema keywords inline. */
const SWAGGER2_PARAMETER_SCHEMA_KEYS = [
  'type',
  'format',
  'items',
  'enum',
  'default',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'pattern',
  'maxItems',
  'minItems',
  'uniqueItems',
  'multipleOf',
] as const;

function instancePathToPointer(instancePath: string): Pointer {
  return instancePath === '' ? [] : refToPath(`#${instancePath}`);
}

/** Validates a parsed Swagger 2.0 / OpenAPI 3.0 / 3.1 document. Never reads files or URLs. */
export async function validateSpecDocument(doc: unknown): Promise<SpecIssue[]> {
  // The validator treats a string as a file name or YAML text; only parsed objects come in.
  if (!isPlainObject(doc)) return [{ path: [], message: 'the spec is not a JSON or YAML object' }];
  // The validator keeps a reference to the document and may annotate it; give it a copy.
  const result = await new Validator().validate(structuredClone(doc));
  if (result.valid) return [];
  if (!Array.isArray(result.errors)) {
    return [{ path: [], message: 'the spec is not a Swagger 2.0, OpenAPI 3.0 or OpenAPI 3.1 document' }];
  }
  // Ajv messages name keywords and property names of the meta-schema, not instance values;
  // `params` (which can hold allowed values) are left out.
  return result.errors.slice(0, MAX_VALIDATION_ISSUES).map((error) => ({
    path: instancePathToPointer(error.instancePath),
    message: error.message ?? 'is invalid',
  }));
}

function isJsonMediaType(mediaType: string): boolean {
  const base = (mediaType.split(';')[0] ?? '').trim().toLowerCase();
  return base === 'application/json' || /^application\/[^/]+\+json$/.test(base);
}

export function normaliseSpec(doc: Record<string, unknown>): { operations: NormalisedOperation[]; issues: SpecIssue[] } {
  const issues: SpecIssue[] = [];
  const operations: NormalisedOperation[] = [];
  const swagger2 = doc.swagger === '2.0';

  const resolvePointer = (ref: string): unknown => {
    let node: unknown = doc;
    for (const segment of refToPath(ref)) {
      if (Array.isArray(node)) node = node[Number(segment)];
      else if (isPlainObject(node) && Object.hasOwn(node, segment)) node = node[segment];
      else return undefined;
    }
    return node;
  };
  type Budget = NonNullable<TranslateContext['budget']>;
  const translate = (schema: unknown, at: Pointer, budget: Budget): Record<string, unknown> => {
    const ctx: TranslateContext = { resolve: resolvePointer, depth: 0, at, issues, budget };
    return toJsonSchema2020(schema, ctx);
  };
  /** Follows `$ref`s of parameter, path item and request body objects (not schemas). */
  const deref = (value: unknown, at: Pointer): Record<string, unknown> | undefined => {
    let node = value;
    for (let hops = 0; isPlainObject(node) && typeof node.$ref === 'string'; hops += 1) {
      const ref = node.$ref;
      if (!ref.startsWith('#')) {
        addIssue(issues, [...at, '$ref'], 'external $ref is not supported');
        return undefined;
      }
      const target = hops < 8 ? resolvePointer(ref) : undefined;
      if (target === undefined) {
        addIssue(issues, [...at, '$ref'], '$ref does not resolve in the document');
        return undefined;
      }
      node = target;
    }
    return isPlainObject(node) ? node : undefined;
  };

  const paths = isPlainObject(doc.paths) ? doc.paths : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const itemAt: Pointer = ['paths', path];
    const item = deref(rawItem, itemAt);
    if (item === undefined) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];

    for (const [methodKey, rawOp] of Object.entries(item)) {
      const method = METHODS.get(methodKey);
      if (method === undefined || !isPlainObject(rawOp)) continue;
      const opAt: Pointer = [...itemAt, methodKey];
      const own = Array.isArray(rawOp.parameters) ? rawOp.parameters : [];

      // Path-level parameters first; an operation parameter with the same name and
      // location replaces it in place.
      const merged: { param: Record<string, unknown>; at: Pointer }[] = [];
      const add = (list: unknown[], base: Pointer): void => {
        list.forEach((raw, i) => {
          const at = [...base, 'parameters', i];
          const param = deref(raw, at);
          if (param === undefined || typeof param.name !== 'string' || typeof param.in !== 'string') return;
          const index = merged.findIndex((m) => m.param.name === param.name && m.param.in === param.in);
          if (index >= 0) merged[index] = { param, at };
          else merged.push({ param, at });
        });
      };
      add(shared, itemAt);
      add(own, opAt);

      const op: NormalisedOperation = { method, path, parameters: [] };
      const budget: Budget = { remaining: MAX_SCHEMA_NODES, truncated: false };
      if (typeof rawOp.operationId === 'string' && rawOp.operationId !== '') op.operationId = rawOp.operationId;
      if (typeof rawOp.summary === 'string') op.summary = rawOp.summary;

      for (const { param, at } of merged) {
        const location = param.in;
        const name = param.name as string; // checked to be a string in `add`
        if (location === 'body') {
          if (swagger2 && acceptsJson(rawOp.consumes ?? doc.consumes)) {
            op.jsonBody = { required: param.required === true, schema: translate(param.schema, [...at, 'schema'], budget) };
          }
          continue;
        }
        if (location !== 'path' && location !== 'query' && location !== 'header') continue;
        const schema = swagger2
          ? translate(swagger2ParameterSchema(param), at, budget)
          : translate(oas3ParameterSchema(param), schemaAt(param, at), budget);
        if (typeof param.description === 'string' && schema.description === undefined) schema.description = param.description;
        op.parameters.push({ name, in: location, required: location === 'path' || param.required === true, schema });
      }

      if (!swagger2 && rawOp.requestBody !== undefined) {
        const bodyAt: Pointer = [...opAt, 'requestBody'];
        const body = deref(rawOp.requestBody, bodyAt);
        const content = body !== undefined && isPlainObject(body.content) ? body.content : {};
        const mediaType = Object.keys(content).find(isJsonMediaType);
        if (body !== undefined && mediaType !== undefined) {
          const media = content[mediaType];
          const schema = isPlainObject(media) ? media.schema : undefined;
          op.jsonBody = { required: body.required === true, schema: translate(schema, [...bodyAt, 'content', mediaType, 'schema'], budget) };
        }
      }
      if (budget.truncated) addIssue(issues, opAt, 'input schema truncated: too large to inline');
      for (const placeholder of path.matchAll(/\{([^}]*)\}/g)) {
        const name = placeholder[1] ?? '';
        if (!op.parameters.some((p) => p.in === 'path' && p.name === name)) {
          addIssue(issues, opAt, `path placeholder {${name}} has no path parameter`);
        }
      }
      operations.push(op);
    }
  }
  return { operations, issues };
}

function addIssue(issues: SpecIssue[], path: Pointer, message: string): void {
  pushIssue(issues, path, message);
}

function acceptsJson(consumes: unknown): boolean {
  if (!Array.isArray(consumes) || consumes.length === 0) return true;
  return consumes.some((m) => typeof m === 'string' && isJsonMediaType(m));
}

function swagger2ParameterSchema(param: Record<string, unknown>): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  for (const key of SWAGGER2_PARAMETER_SCHEMA_KEYS) if (param[key] !== undefined) schema[key] = param[key];
  return schema;
}

/** OAS 3: `schema`, or the schema of a JSON entry in `content`. */
function oas3ParameterSchema(param: Record<string, unknown>): unknown {
  if (param.schema !== undefined) return param.schema;
  if (!isPlainObject(param.content)) return {};
  const mediaType = Object.keys(param.content).find(isJsonMediaType);
  const media = mediaType === undefined ? undefined : param.content[mediaType];
  return isPlainObject(media) ? media.schema : {};
}

function schemaAt(param: Record<string, unknown>, at: Pointer): Pointer {
  if (param.schema !== undefined) return [...at, 'schema'];
  if (!isPlainObject(param.content)) return at;
  const mediaType = Object.keys(param.content).find(isJsonMediaType);
  return mediaType === undefined ? at : [...at, 'content', mediaType, 'schema'];
}
