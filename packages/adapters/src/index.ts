/** Upstream adapters (MCP upstream, OpenAPI). Depend on the connector SDK only. */
export { validateSpecDocument, normaliseSpec, type NormalisedOperation, type NormalisedParameter } from './openapi/normalise.js';
export { toJsonSchema2020, MAX_REF_DEPTH, type TranslateContext } from './openapi/schema-translate.js';
export { deriveCatalog, operationLabel } from './openapi/derive.js';
export { buildRequest, MappingError, type HttpRequestSpec } from './openapi/request.js';
export { mapResponse } from './openapi/response.js';
export { buildBulkBody, extractBatchId, isSafeBatchId, mapBulkStatus } from './openapi/bulk.js';
export { assertEgressAllowed, isBlockedAddress, allowedHostsOf, createGuardedLookup, EgressDeniedError, type Resolver } from './http/egress.js';
export { createScrubber, REDACTED, type Scrubber } from './http/scrub.js';
export {
  createConnectionClient,
  createTransport,
  MAX_RESPONSE_BYTES,
  MAX_RETRY_AFTER_MS,
  type ConnectionClient,
  type ConnectionClientDeps,
  type RawResult,
  type SendOptions,
  type SendResult,
  type Transport,
} from './http/client.js';
export { fetchClientCredentialsToken, lastTokenScopes, TOKEN_REFRESH_MARGIN_MS, type ClientCredentialsParams, type TokenFetchResult } from './http/oauth.js';
export { Semaphore, semaphoreFor, type Release } from './http/semaphore.js';
export { createOpenApiAdapter, jwtScopes, type OpenApiAdapter, type OpenApiAdapterDeps } from './openapi/adapter.js';
export { createAdapters, type AdaptersDeps, type UpstreamAdapters } from './composite.js';
export { loadSpecFile, fetchSpecUrl, parseSpecText, MAX_SPEC_BYTES, type SpecLoadResult } from './openapi/spec-source.js';
