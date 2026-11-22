# ADR 0053: Release readiness: rate limits, denial suite, CI gates, versioning, documentation

- Status: Accepted
- Date: 2026-11-20

## Context

Phase 10 (SPEC section 7) delivers the security test suite and rate limits (SEC-10, SEC-11), the
conformance, contract and restart tests in CI (NFR-1, NFR-15, NFR-16, NFR-17), installation,
configuration, preset authoring and backup documentation (NFR-9, NFR-13), the versioning policy
(NFR-18), a contribution guide, license headers and an example configuration. Its acceptance
criterion needs a newcomer who installs from the public documentation only.

Found in the code before deciding:
- Rate limiting exists only as the role limit `calls_per_minute` (POL-4). It counts granted operation
  calls per (subject, role) in `rate_bucket`, never built-ins, `tools/list`, resources or tasks, and
  only when a role sets it. Unauthenticated requests are never limited. A known gap: anonymous
  `/auth/login` requests and garbage tokens fill `web_login` and the audit table.
- Denial paths are tested piecemeal. Some tests are named `SEC-11` (page refusals, the decision
  service). There is no catalog of the SPEC section 5.3 denial paths and no check that each one has
  a test.
- There is no `SECURITY.md`, no dependency scanning, no `LICENSE`, no `README.md`, no
  `CONTRIBUTING.md`, no license headers and no example configuration outside `deploy/config`.
- `pnpm audit --prod` (2026-11-20) reports 2 high advisories:
  - `@opentelemetry/exporter-prometheus` <0.217.0, GHSA-q7rr-3cgh-j5r3;
  - `@opentelemetry/propagator-jaeger` <2.9.0 (patched >=2.12.1, through
    `@opentelemetry/sdk-trace-node`), GHSA-45rx-2jwx-cxfr.

  It also reports 4 moderate advisories: esbuild through drizzle-kit, `@opentelemetry/core` <2.8.0,
  and glob/minimatch through testcontainers.
- `ci.sh` already runs integration tests against Testcontainers PostgreSQL and the Temporal test
  server (NFR-15). Preset contract tests run against recordings in `pnpm test` (NFR-17). No MCP
  conformance suite runs (NFR-16). Restarts are tested only for a killed worker (Phase 5
  `durability.int.test.ts`, `phase-5.sh`), and not in hosted CI (NFR-1).
- The `@mandate/connector-sdk` package version is `0.0.0`, while `CONNECTOR_SDK_VERSION` is `0.6.0`.
  The configuration schema is versioned only by the YAML literal `version: 1`. No public API
  snapshot exists.

## Options considered

1. **Split of the work:** one part; four (security; quality gates; versioning and repository
   hygiene; documentation and acceptance).
2. **SEC-10 enforcement point:** extend the role limit to every request; a separate endpoint limit
   in the MCP controller after token verification, keyed by caller subject, applied to every
   authenticated `POST /mcp`; an in-memory limiter per instance.
3. **SEC-10 answer shape:** a tool result with `isError`; HTTP 200 with a JSON-RPC error; HTTP 429
   with `Retry-After` and a JSON-RPC error body.
4. **Unauthenticated traffic:** leave it unlimited (spec text names users and service accounts only);
   limit it per client address on `/mcp` 401 answers and on `/auth/login` and `/auth/callback`.
5. **Rate-limit configuration:** environment variables; a YAML block in the configuration
   (hot-reloaded, audited, diffed like other authority settings) with secure defaults when absent.
6. **SEC-11 denial suite:** more tests per module; a machine-readable catalog of every SPEC section
   5.3 denial path, with each entry naming its test, and a completeness test that fails when a deny
   reason or limit has no entry or an entry names no existing test.
7. **Dependency scanning:** GitHub Dependabot only; `pnpm audit` in CI with a reviewed, expiring
   allowlist, plus Dependabot for update PRs; a third-party scanner service.
8. **NFR-16 conformance suite:** a hand-written protocol test; the official
   `@modelcontextprotocol/conformance` CLI against the real endpoint.
9. **NFR-1 restart tests:** Temporal test server and Testcontainers in Vitest; a Compose-based
   script that kills each of `api`, `worker`, PostgreSQL and Temporal during a real execution against
   a fake Magento container, run in hosted CI.
10. **Versions at release:** stay on 0.x; declare 1.0.0 for the product, the connector SDK and the
    configuration schema.
11. **Enforcing NFR-18:** a policy document only; committed public-surface reports (connector SDK
    declarations, configuration JSON Schema) checked in CI, plus a semver gate that compares the
    report with the merge base and demands a major bump for removed or changed lines and a minor
    bump for additions.
12. **License headers:** none (LICENSE file only); SPDX headers on every source file, enforced by a
    repository test.
13. **Acceptance with a human installer:** count an automated run as the acceptance; run an
    automated clean-room dry run that executes the commands of the public guide as written, and keep
    the newcomer run as a separate step.
14. **Terminal path for the walkthrough:** require a hosted AI client (needs public HTTPS,
    [ADR 0009](0009-offline-access-and-observed-client-registration.md)); document the reference terminal client (`tooling/acceptance/login.mjs`,
    `mcp-call.mjs`) as the required path, and a real AI client as optional.

## Decision

1. **Four parts, in this order:** security, quality gates, versioning, documentation. The
   documentation comes last because it documents the rate-limit block, the versions and the example
   configuration that the earlier parts create.
2. **Endpoint limit after token verification** (option 2b).
   - The MCP controller calls an `EndpointRateLimiter` after `BearerGate.authenticate` succeeds and
     before the SDK handler runs. The limiter is keyed `mcp:user:<subject>` or
     `mcp:sa:<client_id>` and counted in the shared `rate_bucket` table (the existing `RateCounter`
     port), so the limit holds across `api` instances (NFR-3).
   - Every authenticated MCP request counts: `tools/list`, every `tools/call` including built-ins,
     `resources/*` and `tasks/*`.
   - The role limit `calls_per_minute` stays unchanged and applies in addition.
   - A failing counter fails closed with 503.
3. **HTTP 429 with `Retry-After`** (seconds to the end of the window). The body is a JSON-RPC error:
   - shape: `{"jsonrpc":"2.0","id":<request id or null>,"error":{"code":-32000,...}}`;
   - `message`: `"Rate limit exceeded; retry after N seconds"`;
   - `data`: `{"reason":"rate_limited","retryAfterSeconds":N}`.

   Only the first over-limit request of a (key, window) writes an audit row: `rate.limited`, with
   actor, client ID, correlation ID and `{scope, limit}`, so a flood cannot fill the audit table.
4. **Unauthenticated requests are limited per client address** (option 4b), to close the gap named
   under Context.
   - Before the `auth.rejected` audit row, the `web_login` row, or the redirect is written, the
     request is counted under `anon:<address>`. Over the limit it gets 429, and nothing more is
     written than the one `rate.limited` row per window.
   - The address is Express `req.ip` under `trust proxy` = `MANDATE_TRUST_PROXY` (hop count 0-10,
     default 0: the socket address).
   - IPv4-mapped IPv6 addresses are reduced to IPv4. Other IPv6 addresses are keyed by their /64
     prefix, so rotating within a prefix gains nothing.
   - This is additive to SEC-10's text, so the spec is not changed.
5. **YAML block `rate_limits`** (option 5b), at most one document, optional, with defaults when it
   is absent:
   - `mcp_user_per_minute` (default 300);
   - `mcp_service_account_per_minute` (default 600);
   - `unauthenticated_per_minute` (default 60).

   Each value is an integer from 1 to 100000. Rate limiting cannot be switched off. A service account
   may override its own limit with `service_accounts[].rate_limit_per_minute`. `config diff` reports
   the block as an authority key. The schema change is additive (`version: 1` stays).
6. **Denial catalog plus completeness test** (option 6b).
   - Each catalog entry names its requirement (POL-1 ... POL-8, SEC-10, MCP-3), the deny reason or
     refusal code, and the file and title of the test that proves it.
   - The completeness test fails when:
     - a member of `DenyReason`, `LimitName` or the policy-related `StartRefusal` codes has no entry;
     - an entry's test title is not in its file.
   - The new end-to-end suite drives each path through the real MCP endpoint (and the page or worker
     where the path lives). It asserts the answer, exactly one deny audit row with its rule, and no
     upstream request.
7. **`pnpm audit` gate plus Dependabot** (option 7b).
   - The gate fails on any high or critical advisory that is not in `security/audit-allowlist.yaml`.
     Each allowlist entry carries an advisory ID, the package, a reason and an `expires` date at most
     90 days ahead. An expired entry fails the gate.
   - Moderate and low advisories are printed, not gated.
   - The gate runs in `ci.sh` and in a scheduled weekly hosted job, so advisories published after a
     push still surface.
   - `.github/dependabot.yml` covers npm, Docker and GitHub Actions.
   - The two current high advisories are fixed by upgrading the OpenTelemetry packages
     ([ADR 0054](0054-opentelemetry-2x-with-temporal-1x-plugin.md)). The replay gate (traced fixtures) and the tracing tests must still pass.
8. **Official conformance CLI** (option 8b), pinned as a dev dependency:
   `@modelcontextprotocol/conformance@0.2.0-alpha.12`. It is the first release with `--requirements`.
   0.1.16, the `latest` tag, has no 2026-07-28 requirement set.
   - It runs in the e2e project against the in-process `api`, behind a token-injecting proxy, because
     the server subcommand has no option to send an `Authorization` header.
   - It runs twice:
     - `--requirements 2026-07-28` (stateless path);
     - `--requirements 2025-11-25` (legacy path, MCP-1).
   - Each run has a committed expected-failures baseline. An entry is allowed only for a scenario
     that needs a conformance-fixture capability the platform deliberately does not offer, and it
     carries that reason. Examples: fixture tools such as image or audio results, prompts,
     completion, sampling or elicitation round trips.
   - Any other failure is a defect: it is debugged and fixed, or an ADR records it and the spec is
     corrected.
9. **Compose restart script in hosted CI** (option 9b): `scripts/acceptance/restart.sh`.
   - A fake Magento container serves the bulk API from `packages/testing`'s fake catalog, with a
     control route that reports per-SKU submissions.
   - For each component, the script kills it with SIGKILL while a bulk batch is being polled, starts
     it again, and checks the result:
     - the change-set completes;
     - every item is written exactly once with its value;
     - no SKU outside the change-set is touched;
     - the hash is unchanged;
     - `audit verify` passes.
   - It also kills `worker` and Temporal while a change-set waits in `pending_approval`, then
     approves and completes it.
   - Kill points are taken while a bulk is being polled, outside the residual window of
     [ADR 0007](0007-magento-bulk-and-idempotency.md) (between upstream accept and recording the bulk ID). That window stays a
     known gap.
10. **1.0.0 at release** (option 10b):
    - product `1.0.0` (root `package.json`, image label);
    - `@mandate/connector-sdk` `1.0.0` (package version equals `CONNECTOR_SDK_VERSION`);
    - configuration schema `1.0.0` (`CONFIG_SCHEMA_VERSION`, major = the YAML `version` literal);
    - both presets `1.0.0`, with `mandate.sdk: ^1.0.0`.

    Every preset version range in the repository (dev configuration, fixtures, acceptance
    generators) is updated together with the versions, so the earlier acceptance scripts keep
    passing.
11. **Committed surface reports and a semver gate** (option 11b):
    - `packages/connector-sdk/api-report.d.ts`: declarations reachable from the package entry,
      comments stripped, files sorted;
    - `packages/config/schema/mandate-config.v1.json`: Zod 4 `z.toJSONSchema`. Verified 2026-11-20 in
      `packages/config` with zod 4.6.7: a strict object exports draft 2020-12 with
      `additionalProperties: false`.

    `--check` fails when a report is stale. The gate compares each report with the one at the merge
    base. Removed or changed lines need a higher major version. Lines that are only added need at
    least a higher minor version. The gate is a heuristic that backs up review, not a substitute for
    it. The policy is public in [the versioning guide](../guide/versioning.md).
    *Amended later: lines are keyed by context, narrowing additions count as breaking, and a third
    report covers the preset format.*
12. **SPDX headers** (option 12b): `SPDX-License-Identifier: Apache-2.0` and
    `Copyright 2026 The Mandate Authors`.
    - Covered files: tracked `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.sh` and `Dockerfile` sources.
      The header goes after a shebang line.
    - Excluded: committed migrations (never edited on `main`), `spikes/`, recordings, workflow
      histories, JSON and generated bundles.
    - A commit that touches `presets/gitea-issues` touches nothing under `packages/core`, `apps/api`
      or `apps/worker`, so the Phase 9 `no-core-change` acceptance check still passes.
    - Preset code changes its digest, and so the configuration hash. The release notes say to re-run
      `config apply` after upgrading.
13. **Clean-room dry run, with the newcomer run as a separate step** (option 13b).
    - `scripts/acceptance/phase-10.sh` clones HEAD and runs, in order, every block the public guide
      marks `<!-- doc-test -->`, exactly as written. Each browser step has a scripted equivalent
      marked `<!-- doc-test-alt -->`.
    - Its checks map to the four acceptance clauses: install, attach a Magento sandbox, configure one
      role, an approved bulk update. It also runs a backup and restore check (NFR-13).
    - The dry run alone does not meet the acceptance criterion; the newcomer run is recorded
      separately ([ADR 0059](0059-documentation-acceptance-by-clean-clone-walkthrough.md)).
14. **Reference terminal client as the required path** (option 14b). The walkthrough uses
    `tooling/acceptance/login.mjs` and `mcp-call.mjs`, documented as the reference terminal client for
    the development realm (password grant). The approver decides on the trusted page in a browser.
    Connecting Claude or ChatGPT is optional, and its section points to the registration facts of
    [ADR 0004](0004-authorization-and-client-registration.md) and [ADR 0009](0009-offline-access-and-observed-client-registration.md) (CIMD needs a public HTTPS origin). No promise is
    made about clients the project has not verified.

## Consequences

- Every authenticated MCP request costs one `rate_bucket` upsert. This is accepted for a
  single-tenant deployment. Retention already prunes the table.
- Authenticated page REST routes are not limited by SEC-10 (it names the MCP endpoint). This is
  recorded as a known gap.
- The conformance pin is a pre-release. The pin and its baselines change only together, in one
  reviewed commit.
- The restart job adds about 20 minutes to hosted CI. It needs no Magento sandbox.
- Upgrading from a pre-release build re-runs `config apply`. The preset versions, SDK range and
  headers change the configuration hash. CHANGELOG 1.0.0 carries this, and the
  [ADR 0051](0051-mcp-upstream-opaque-presets-service-accounts-details.md) release-note items.
- The newcomer acceptance run cannot be automated by the dry run; it is a separate step
  ([ADR 0059](0059-documentation-acceptance-by-clean-clone-walkthrough.md)).

## Verified

- `@modelcontextprotocol/conformance`, 2026-11-20:
  - `npm view` shows `latest` 0.1.16 (2026-03-30) and `alpha` 0.2.0-alpha.12 (2026-10-01).
  - From the packed tarball: `requirements/2026-07-28.yaml` lists 37 server scenarios, anchored on
    0.2.0-alpha.10. Examples: `server-stateless`, `tools-list`, `caching`,
    `dns-rebinding-protection`, `sep-2164-resource-not-found`, fixture tool scenarios, prompts,
    `input-required-result-*`.
  - The `server` subcommand options are `--url`, `--scenario`, `--suite`, `--expected-failures`,
    `-o`, `--spec-version`, `--force`, `--requirements`, `--timeout` and `--verbose`. There is no
    header or token option, so the token-injecting proxy is needed. Read from the `command('server')`
    definition in `dist/index.js`.
  - The package is MIT-licensed and needs Node >= 20.
- MCP rate limiting, 2026-11-20:
  - The 2026-07-28 specification defines no rate-limit error.
  - SEP-3304 (code -32023 bound to HTTP 429) is closed and not merged:
    `gh api repos/modelcontextprotocol/modelcontextprotocol/pulls/3304` -> `state: closed`,
    `merged: false`.
  - `@modelcontextprotocol/client` 2.4.0 has no 429 handling (grep of `dist`). Hence 429 with a
    server-defined `-32000` error, not the reserved -32023.
- `pnpm audit --prod --json`, 2026-11-20: the advisories listed under Context.
