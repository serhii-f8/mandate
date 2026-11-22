// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { CatalogEntry, HttpMethod, SpecIssue, TemplateValue, ToolListOutcome, UpstreamResolver } from '@mandate/connector-sdk';

type ResolveInput = Parameters<UpstreamResolver['resolveSpec']>[0];
type ResolveToolsInput = Parameters<NonNullable<UpstreamResolver['resolveTools']>>[0];

/**
 * An `UpstreamResolver` that answers from fixed catalogs per connection ID instead of
 * reading a spec. `failures` makes a connection's spec fail with the given issues.
 * Every call is recorded. `include` filters by operation ID or `METHOD /path`, as the
 * OpenAPI adapter does.
 *
 * `tools` answers `resolveTools` per connection ID (an empty list for any other); only
 * when it is given does the resolver have `resolveTools` at all, as an own property, so
 * a resolver built without it behaves like a 0.5.0 resolver.
 */
export class FakeResolver implements UpstreamResolver {
  readonly calls: ResolveInput[] = [];
  readonly toolCalls: ResolveToolsInput[] = [];
  // `declare`: no class field is emitted, so the property exists only when assigned below.
  declare readonly resolveTools?: (input: ResolveToolsInput) => Promise<ToolListOutcome>;

  constructor(
    private readonly catalogs: Readonly<Record<string, readonly CatalogEntry[]>> = {},
    private readonly failures: Readonly<Record<string, readonly SpecIssue[]>> = {},
    tools?: Readonly<Record<string, ToolListOutcome>>,
  ) {
    if (tools !== undefined) {
      this.resolveTools = (input) => {
        this.toolCalls.push(input);
        return Promise.resolve(tools[input.connection.id] ?? { ok: true, tools: [], dropped: 0, durationMs: 0 });
      };
    }
  }

  resolveSpec(input: ResolveInput): ReturnType<UpstreamResolver['resolveSpec']> {
    this.calls.push(input);
    const failure = this.failures[input.connection.id];
    if (failure !== undefined) return Promise.resolve({ ok: false, issues: failure });
    const catalog = this.catalogs[input.connection.id] ?? [];
    const include = input.include;
    if (include === undefined) return Promise.resolve({ ok: true, catalog });
    const issues: SpecIssue[] = [];
    include.forEach((selector, i) => {
      if (!catalog.some((e) => matches(e, selector))) issues.push({ path: ['openapi', 'include', i], message: 'matches no operation in the spec' });
    });
    if (issues.length > 0) return Promise.resolve({ ok: false, issues });
    return Promise.resolve({ ok: true, catalog: catalog.filter((e) => include.some((s) => matches(e, s))) });
  }
}

function matches(entry: CatalogEntry, selector: string): boolean {
  return entry.operationId === selector || `${entry.method} ${entry.path}` === selector;
}

/**
 * A catalog entry shaped like the OpenAPI adapter's: string arguments for the path and
 * query parameters (path parameters required), and the default mapping that takes each
 * parameter from the argument of the same name.
 */
export function fakeCatalogEntry(
  connection: string,
  entry: {
    operationId?: string;
    method: HttpMethod;
    path: string;
    summary?: string;
    query?: readonly string[];
    inputSchema?: Record<string, unknown>;
  },
): CatalogEntry {
  const pathParams = [...entry.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? '');
  const query = entry.query ?? [];
  const argMap = (names: readonly string[]): Record<string, TemplateValue> => Object.fromEntries(names.map((n) => [n, { arg: n }]));
  const inputSchema = entry.inputSchema ?? {
    type: 'object',
    properties: Object.fromEntries([...pathParams, ...query].map((n) => [n, { type: 'string' }])),
    ...(pathParams.length > 0 ? { required: pathParams } : {}),
    additionalProperties: false,
  };
  const result: CatalogEntry = {
    key: `${connection}:${entry.operationId ?? `${entry.method} ${entry.path}`}`,
    method: entry.method,
    path: entry.path,
    inputSchema,
    defaultMapping: {
      method: entry.method,
      path: entry.path,
      pathParams: argMap(pathParams),
      query: argMap(query),
      headers: {},
      response: { maxItems: 100 },
    },
  };
  if (entry.operationId !== undefined) result.operationId = entry.operationId;
  if (entry.summary !== undefined) result.summary = entry.summary;
  return result;
}
