// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * Derived catalog (CONN-2, design §4.3): one entry per imported operation, keyed
 * `<connection>:<operationId or "METHOD /path">`, with an input schema built from the
 * path, query and header parameters plus `body`, and the default mapping that takes each
 * parameter from the argument of the same name. Credential-bearing headers are never
 * exposed as arguments.
 */
import type { CatalogEntry, SpecIssue, TemplateValue, UpstreamMapping } from '@aiops/connector-sdk';
import { FORBIDDEN_HEADERS } from '../http/headers.js';
import type { NormalisedOperation } from './normalise.js';

const DEFAULT_MAX_ITEMS = 100;

export function operationLabel(op: Pick<NormalisedOperation, 'operationId' | 'method' | 'path'>): string {
  return op.operationId ?? `${op.method} ${op.path}`;
}

function matches(op: NormalisedOperation, selector: string): boolean {
  return op.operationId === selector || `${op.method} ${op.path}` === selector;
}

export function deriveCatalog(
  connectionId: string,
  ops: readonly NormalisedOperation[],
  include?: readonly string[],
): { catalog: CatalogEntry[]; issues: SpecIssue[] } {
  const issues: SpecIssue[] = [];
  let selected = ops;
  if (include !== undefined) {
    include.forEach((selector, i) => {
      if (!ops.some((op) => matches(op, selector))) issues.push({ path: ['openapi', 'include', i], message: 'matches no operation in the spec' });
    });
    selected = ops.filter((op) => include.some((selector) => matches(op, selector)));
  }

  const catalog: CatalogEntry[] = [];
  const keys = new Set<string>();
  for (const op of selected) {
    const opAt = ['paths', op.path, op.method.toLowerCase()];
    const key = `${connectionId}:${operationLabel(op)}`;
    if (keys.has(key)) {
      issues.push({ path: [...opAt, 'operationId'], message: 'duplicates another operation key' });
      continue;
    }
    keys.add(key);

    const properties = new Map<string, Record<string, unknown>>();
    const required: string[] = [];
    const mapping: Record<'path' | 'query' | 'header', Record<string, TemplateValue>> = { path: {}, query: {}, header: {} };
    for (const param of op.parameters) {
      if (param.in === 'header' && FORBIDDEN_HEADERS.has(param.name.toLowerCase())) continue;
      if (properties.has(param.name) || (param.name === 'body' && op.jsonBody !== undefined)) {
        issues.push({ path: [...opAt, 'parameters', param.name], message: 'parameter name collides with another argument; it is not exposed' });
        continue;
      }
      properties.set(param.name, param.schema);
      if (param.required) required.push(param.name);
      // Own data property even for names like `__proto__`.
      Object.defineProperty(mapping[param.in], param.name, { value: { arg: param.name }, enumerable: true, writable: true, configurable: true });
    }
    if (op.jsonBody !== undefined) {
      properties.set('body', op.jsonBody.schema);
      if (op.jsonBody.required) required.push('body');
    }

    const inputSchema: Record<string, unknown> = {
      type: 'object',
      properties: Object.fromEntries(properties),
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
    const defaultMapping: UpstreamMapping = {
      method: op.method,
      path: op.path,
      pathParams: mapping.path,
      query: mapping.query,
      headers: mapping.header,
      ...(op.jsonBody !== undefined ? { body: { arg: 'body' } } : {}),
      response: { maxItems: DEFAULT_MAX_ITEMS },
    };
    const entry: CatalogEntry = { key, method: op.method, path: op.path, inputSchema, defaultMapping };
    if (op.operationId !== undefined) entry.operationId = op.operationId;
    if (op.summary !== undefined) entry.summary = op.summary;
    catalog.push(entry);
  }
  return { catalog, issues };
}
