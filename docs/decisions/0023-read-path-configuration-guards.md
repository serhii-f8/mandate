# ADR 0023: Configuration guards for the direct read path

- Status: Accepted
- Date: 2026-11-17

Extends [ADR 0017](0017-upstream-configuration-registry-and-read-path.md) and [ADR 0021](0021-configuration-loader-registry-rules.md).

## Context

A review of the whole of Phase 3 found three ways an ordinary-looking configuration could
defeat the policy on the read path, although each component was correct alone:

1. a single-object response (`response.items` absent) skipped projection, so a field the
   grant denies came back when upstream sent it unasked (POL-3);
2. nothing tied the argument the policy checks (`fields_arg`) to the argument projection
   uses (`response.fields_from_arg`), and nothing checked that a scope argument (POL-2) is
   actually sent upstream;
3. an operation labelled `risk: read` could be bound to POST, PUT, PATCH or DELETE and run
   at once through the direct read path, skipping change-sets and approval.

## Options considered

- For 1–2: document the pitfalls; enforce them in the loader and the adapter.
- For 3: allow any method; refuse non-GET reads; allow non-GET reads with an explicit
  opt-in (for read-style POST searches).

## Decision

- Projection and flattening apply to single-object responses too; with projection
  configured, non-object items or bodies yield nothing.
- The loader reports an issue when `fields_arg` and `response.fields_from_arg` differ
  (either absent while the other is set), and when a grant's scope argument is referenced
  by no template of the operation's mapping (path, query, header, body, or the projection
  argument; derived operations reference every parameter).
- **A `read` operation must resolve to GET**, for configuration, preset and derived
  operations; the read invoker checks again. No opt-in in Phase 3: read-style POST
  searches can be added later with an explicit flag and its own review; until then they
  are not reachable rather than reachable without approval.

## Consequences

- Some test fixtures changed to send scope arguments upstream and declare
  `fields_from_arg`; the development configuration and the Magento preset already
  complied.
- Upstream APIs that search only by POST cannot be exposed as reads yet.

## Verified

Tests in `packages/adapters/src/openapi/response.test.ts`,
`packages/config/src/registry.test.ts` (titles with POL-2, POL-3, MCP-4) and
`apps/api/src/upstream/read-invoker.test.ts`; `pnpm mandate validate deploy/config
--preset-dir presets` exits 0 (2026-11-17).
