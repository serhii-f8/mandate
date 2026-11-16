/**
 * Schemas of the upstream side of the configuration (design part 1 §3, ADR 0017):
 * connection settings and auth, the operation's `upstream` mapping, and their
 * conversion to the `@aiops/connector-sdk` types. Strict like the rest (ADR 0015).
 */
import type { AuthSettings, ResponseMapping, TemplateValue, UpstreamMapping } from '@aiops/connector-sdk';
import { z } from 'zod';

export const id = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
/** Operation IDs are also MCP tool names. */
export const OPERATION_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
export const operationId = z.string().max(64).regex(OPERATION_ID);
export const httpUrl = z.url({ protocol: /^https?$/ }).refine(
  (v) => {
    // Zod runs refinements even after `z.url()` failed; that failure is already reported (CFG-2).
    if (!URL.canParse(v)) return true;
    const url = new URL(v);
    return url.username === '' && url.password === '';
  },
  // CFG-5: a URL with credentials in it is a secret in configuration.
  { message: 'must not contain a user name or password; reference a credential by name' },
);
export const openObject = z.record(z.string(), z.unknown());

/** RFC 9110 token characters. */
const headerName = z.string().min(1).max(256).regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);

export const authSchema = z.discriminatedUnion('scheme', [
  z.strictObject({ scheme: z.literal('bearer') }),
  z.strictObject({ scheme: z.literal('api_key'), header: headerName }),
  z.strictObject({ scheme: z.literal('basic') }),
  z.strictObject({
    scheme: z.literal('oauth_client_credentials'),
    token_url: httpUrl,
    scopes: z.array(z.string().min(1).max(256)).default([]),
  }),
]);
export type AuthConfig = z.output<typeof authSchema>;

/** CONN-7: the operation and arguments of a connection test. */
export const connectionTestSchema = z.strictObject({ operation: operationId, args: openObject.default({}) });
export type ConnectionTestConfig = z.output<typeof connectionTestSchema>;

const URL_LIKE = /^[a-z][a-z0-9+.-]*:/i;
/** An http(s) URL, or a file path relative to the file that declares it. */
export const specReference = z
  .string()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    if (URL_LIKE.test(value) && !httpUrl.safeParse(value).success) {
      ctx.addIssue({ code: 'custom', message: 'must be an http(s) URL without user name or password, or a file path' });
    }
  });

export const isSpecUrl = (spec: string): boolean => URL_LIKE.test(spec);

/** Connection fields shared by every adapter (CONN-5, CONN-6, CONN-7). */
export const connectionSettingsFields = {
  auth: authSchema.optional(),
  timeout_ms: z.number().int().min(1).max(120_000).default(10_000),
  retry: z
    .strictObject({
      max_attempts: z.number().int().min(1).max(10).default(3),
      initial_backoff_ms: z.number().int().min(0).max(60_000).default(200),
    })
    .default({ max_attempts: 3, initial_backoff_ms: 200 }),
  max_concurrency: z.number().int().min(1).max(1000).default(4),
  allow_private_network: z.boolean().default(false),
  test: connectionTestSchema.optional(),
};

export const openApiSchema = z.strictObject({
  spec: specReference,
  include: z.array(z.string().min(1).max(512)).min(1).optional(),
});

const literal = z.union([z.string().max(4000), z.number(), z.boolean()]);
const templateValue = z.union([literal, z.strictObject({ arg: z.string().min(1).max(128), default: literal.optional() })]);
const templateMap = z.record(z.string().min(1).max(256), templateValue);
const dottedPath = z.string().min(1).max(256);

const responseSchema = z.strictObject({
  items: dottedPath.optional(),
  total: dottedPath.optional(),
  flatten: z.strictObject({ path: dottedPath, key: z.string().min(1).max(128), value: z.string().min(1).max(128) }).optional(),
  fields_from_arg: z.string().min(1).max(128).optional(),
  max_items: z.number().int().min(1).max(500).default(100),
});

/** Headers the platform sets itself. `authorization` and `cookie` are caught by the CFG-5 key scan. */
const PLATFORM_HEADERS: ReadonlySet<string> = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);

export const upstreamSchema = z
  .strictObject({
    operation: z.string().min(1).max(512).optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    path: z.string().min(1).max(2048).regex(/^\//).optional(),
    path_params: templateMap.optional(),
    query: templateMap.optional(),
    headers: z.record(headerName, templateValue).optional(),
    body: templateValue.optional(),
    response: responseSchema.optional(),
  })
  .superRefine((u, ctx) => {
    const byPath = u.method !== undefined || u.path !== undefined;
    if (u.operation !== undefined && byPath) {
      ctx.addIssue({ code: 'custom', path: ['operation'], message: 'give either operation or method and path, not both' });
    } else if (u.operation === undefined) {
      if (u.method === undefined) ctx.addIssue({ code: 'custom', path: ['method'], message: 'is required (or give operation)' });
      if (u.path === undefined) ctx.addIssue({ code: 'custom', path: ['path'], message: 'is required (or give operation)' });
    }
    for (const name of Object.keys(u.headers ?? {})) {
      if (PLATFORM_HEADERS.has(name.toLowerCase())) ctx.addIssue({ code: 'custom', path: ['headers', name], message: 'is set by the platform' });
    }
  });
export type UpstreamConfig = z.output<typeof upstreamSchema>;
type TemplateConfig = z.output<typeof templateValue>;

/** True when the block declares request templates, which only an explicit `input_schema` can back. */
export function hasTemplates(u: UpstreamConfig): boolean {
  return (
    Object.keys(u.path_params ?? {}).length > 0 ||
    Object.keys(u.query ?? {}).length > 0 ||
    Object.keys(u.headers ?? {}).length > 0 ||
    u.body !== undefined
  );
}

/** Every `{ arg }` reference of the block with its path inside `upstream`. */
export function templateArgs(u: UpstreamConfig): { arg: string; path: readonly PropertyKey[] }[] {
  const found: { arg: string; path: readonly PropertyKey[] }[] = [];
  const visit = (value: TemplateConfig, path: readonly PropertyKey[]): void => {
    if (typeof value === 'object') found.push({ arg: value.arg, path });
  };
  for (const key of ['path_params', 'query', 'headers'] as const) {
    for (const [name, value] of Object.entries(u[key] ?? {})) visit(value, [key, name]);
  }
  if (u.body !== undefined) visit(u.body, ['body']);
  if (u.response?.fields_from_arg !== undefined) found.push({ arg: u.response.fields_from_arg, path: ['response', 'fields_from_arg'] });
  return found;
}

/** Names of the `{name}` placeholders of a path template. */
export function pathPlaceholders(path: string): string[] {
  return [...path.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1] ?? '');
}

function toTemplate(value: TemplateConfig): TemplateValue {
  if (typeof value !== 'object') return value;
  return value.default === undefined ? { arg: value.arg } : { arg: value.arg, default: value.default };
}

function toTemplates(map: Readonly<Record<string, TemplateConfig>> | undefined): Record<string, TemplateValue> {
  const out: Record<string, TemplateValue> = {};
  // Own data properties even for names like `__proto__`.
  for (const [key, value] of Object.entries(map ?? {})) Object.defineProperty(out, key, { value: toTemplate(value), enumerable: true, writable: true, configurable: true });
  return out;
}

export function toResponse(r: UpstreamConfig['response']): ResponseMapping {
  if (r === undefined) return { maxItems: 100 };
  return {
    ...(r.items === undefined ? {} : { items: r.items }),
    ...(r.total === undefined ? {} : { total: r.total }),
    ...(r.flatten === undefined ? {} : { flatten: { ...r.flatten } }),
    ...(r.fields_from_arg === undefined ? {} : { fieldsFromArg: r.fields_from_arg }),
    maxItems: r.max_items,
  };
}

/** The YAML mapping as the SDK type (snake_case to camelCase, absent maps to `{}`). */
export function toUpstreamMapping(u: UpstreamConfig): UpstreamMapping {
  return {
    ...(u.operation === undefined ? {} : { operation: u.operation }),
    ...(u.method === undefined ? {} : { method: u.method }),
    ...(u.path === undefined ? {} : { path: u.path }),
    pathParams: toTemplates(u.path_params),
    query: toTemplates(u.query),
    headers: toTemplates(u.headers),
    ...(u.body === undefined ? {} : { body: toTemplate(u.body) }),
    response: toResponse(u.response),
  };
}

export function toAuthSettings(a: AuthConfig): AuthSettings {
  switch (a.scheme) {
    case 'bearer':
    case 'basic':
      return { scheme: a.scheme };
    case 'api_key':
      return { scheme: 'api_key', header: a.header };
    case 'oauth_client_credentials':
      return { scheme: 'oauth_client_credentials', tokenUrl: a.token_url, scopes: [...a.scopes] };
  }
}
