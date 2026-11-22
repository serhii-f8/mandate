# ADR 0018: OpenAPI adapter: spec handling, egress guard, redaction

- Status: Accepted
- Date: 2026-11-16

## Context

CONN-2 asks for Swagger 2.0 and OpenAPI 3 with filtered import and derived input
schemas; Magento's schema is Swagger 2.0 with circular references ([ADR 0007](0007-magento-bulk-and-idempotency.md)).
Derived schemas are compiled by Ajv 8.20 in strict mode with JSON Schema 2020-12
([ADR 0015](0015-configuration-format-and-loader.md)). CONN-5 restricts outbound hosts and private ranges; SEC-3 keeps
credentials out of every output.

## Options considered

1. **Swagger 2.0:** convert with `swagger2openapi@7.0.8`; read 2.0 natively in the
   project's own normaliser.
2. **Validation:** `@readme/openapi-parser@10.0.0` (23 packages);
   `@seriousme/openapi-schema-validator@2.12.0` (9 packages, validation only); none.
3. **Schema translation to 2020-12:** pass through; translate keywords.
4. **Egress check:** host allow list only; allow list plus a pre-flight DNS check; allow
   list plus a checked `lookup` the socket uses.
5. **Redaction:** log-path redaction only; plus scrubbing known secret values from every
   adapter output.

## Decision

1. **Native normaliser** for 2.0 and 3.x into one internal model (operation ID, method,
   path, parameters with schemas, JSON request body, schemas by reference). Only
   parameters and request bodies are needed; `swagger2openapi` is unmaintained since 2021
   and pulls 41 packages including a `punycode` deprecation path on Node 22.
2. **`@seriousme/openapi-schema-validator`** for structural validation of 2.0, 3.0, 3.1
   (ESM, small, uses the Ajv already shipped).
3. **Translate:** `nullable: true` → `type: [t, "null"]`; `example` → `examples: [v]`;
   boolean `exclusiveMinimum`/`exclusiveMaximum` → numeric form; drop `xml`,
   `externalDocs`, `discriminator`, `x-*`; `properties` without `type` gets
   `type: object`; `required` entries without a property are dropped; `$ref`s resolved
   locally with a depth limit (deeper or circular → `{}`), external refs are an issue.
   Formats are kept (ajv-formats knows the OpenAPI formats). Found while building it
   (Ajv `strictTypes`): a schema without `type` gets one inferred from its keywords,
   keywords that belong to another type are dropped, a multi-type schema becomes `anyOf`,
   `prefixItems` and invalid `pattern`s are dropped, and one derived input schema
   inlines at most 2000 schema nodes (the rest becomes `{}`, reported as an issue).
4. **Allow list plus checked `lookup`**: the socket connects to the address the lookup
   validated, so a DNS answer cannot change between check and connect; redirects are not
   followed.
5. **Both.** pino `redact` for header, cookie and secret-named paths, and a per-call
   scrubber that replaces every secret value used in the call (raw, Base64 and URL-encoded,
   and the Basic header value) in errors, bodies and mapped items.

## Consequences

- A spec feature outside parameters/request bodies (callbacks, links, webhooks) is
  ignored, not an error.
- Derived schemas may be looser than the spec (dropped keywords, `{}` at depth); the
  upstream remains the business validator (SPEC section 2, Boundaries).
- A secret shorter than 8 characters is still scrubbed, so an unlucky short secret may
  blank unrelated text; acceptable.

## Verified

2026-11-16, throwaway experiments with Node v22.20.0:
- Ajv 8.20.0 `ajv/dist/2020` strict with ajv-formats 3.0.1: `example`, `xml`,
  `externalDocs`, `x-*` throw `strict mode: unknown keyword`; `discriminator` throws
  unless enabled and then needs `oneOf`; boolean `exclusiveMinimum` throws "must be
  number"; `properties` without `type` and `required` with an undefined property throw
  strict errors; `nullable` (with `type`), `readOnly`, `writeOnly`, `deprecated`,
  `examples` compile; formats `int32`, `int64`, `float`, `double`, `byte`, `binary`,
  `password` are known to ajv-formats (`ajv-formats/dist/formats.js:42-52`).
- `npm view`: `swagger2openapi` 7.0.8 published 2021-07-07 (41 packages, `node-fetch@2` →
  `tr46@0.0.3` requires `punycode`); `@readme/openapi-parser` 10.0.0 (2026-10-22, 23
  packages); `@seriousme/openapi-schema-validator` 2.12.0 (2026-11-13, ESM, 9 packages),
  accepted Swagger 2.0, OpenAPI 3.0 and 3.1 documents and rejected a missing
  `info.version` in a test run.
- pnpm `minimumReleaseAge` default 1440 minutes (https://pnpm.io/settings/dependency-resolution);
  the validator was published 3 days before installation.
