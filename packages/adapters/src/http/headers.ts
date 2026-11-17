/**
 * Request headers the platform sets itself or that carry credentials: never taken from
 * a mapping or exposed as an operation argument. The single list for the adapters
 * (derived catalog and request building); `@aiops/config` keeps a copy in
 * `upstream-schema.ts` because it cannot import the adapters.
 */
export const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
]);
