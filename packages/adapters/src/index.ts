/** Upstream adapters (MCP upstream, OpenAPI). Depend on the connector SDK only. */
export { validateSpecDocument, normaliseSpec, type NormalisedOperation, type NormalisedParameter } from './openapi/normalise.js';
export { toJsonSchema2020, MAX_REF_DEPTH, type TranslateContext } from './openapi/schema-translate.js';
export { deriveCatalog, operationLabel } from './openapi/derive.js';
export { buildRequest, MappingError, type HttpRequestSpec } from './openapi/request.js';
export { mapResponse } from './openapi/response.js';
