# Contributing

Thank you for helping. This guide is the short version of how the repository works. The product is
specified in [docs/SPEC.md](docs/SPEC.md); requirement IDs such as `POL-3` or `NFR-18` come from its
sections 5 and 6. Be kind: see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Development setup

Prerequisites: Node 22 (`^22.12.0`), corepack (ships with Node) and Docker (for integration and
end-to-end tests and for the Compose stack).

```sh
corepack enable          # once; pnpm comes from the packageManager field
pnpm install             # CI: pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

| Purpose | Command |
| --- | --- |
| Integration tests (need Docker) | `pnpm test:int` |
| End-to-end tests (need Docker) | `pnpm test:e2e` |
| One package | `pnpm --filter @aiops/<pkg> test` (or `test:int`, `test:e2e`) |
| One file | `cd <pkg> && pnpm exec vitest run --project <unit\|integration\|e2e> <path>` |
| Everything CI runs | `bash scripts/ci.sh` |

More commands (Compose, sandboxes, the configuration CLI, acceptance scripts) are in
[docs/commands.md](docs/commands.md).

## Repository layout and boundaries

- `apps/api` (NestJS: MCP endpoint, policy, change-set creation, REST API for the trusted pages),
  `apps/worker` (Temporal worker: workflows and activities), `apps/web` (static bundle).
- `packages/{core,db,config,connector-sdk,adapters,upstream,temporal,widgets,testing}`,
  `presets/*`, `deploy/`, `examples/`, `docs/`.

Boundaries are enforced by lint (`pnpm lint`, rules in `eslint.boundaries.js`), not by convention:

- `packages/core` depends on no framework, no other workspace package, no database driver, no HTTP
  client and no I/O. It holds the pure domain model, policy, manifest engine and diff.
- `apps/api` and `apps/worker` depend on `core`. `packages/adapters` depends on `connector-sdk` only.
- Presets use only the public interface of `connector-sdk` and the configuration schema. Adding a preset
  must not require a change to `core`, `api` or `worker`.
- Infrastructure is reached through interfaces owned by `core`; implementations live in apps or adapters.
- No model in the trust path: permission checks, diffs, approval views and execution are deterministic
  server code. Upstream content is data, never instructions (SEC-5).
- TypeScript is strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). No `any`, `@ts-ignore`
  or non-null `!` without a comment saying why. External input is parsed with a schema at the boundary.

## Tests

- Unit tests sit next to the code: `src/**/*.test.ts`. `packages/core` tests need no infrastructure.
- Integration tests: `test/integration/**/*.int.test.ts` in the owning package, against real PostgreSQL
  (Testcontainers) and the Temporal test environment. No mocked database.
- End-to-end and acceptance tests: `apps/*/test/e2e/**/*.e2e.test.ts`.
- Shared fakes and fixtures live in `packages/testing`.
- A test that proves a requirement names its ID in the `describe` or `it` title, for example
  `describe('POL-2 scope constraints', ...)`. Every denial path has a test.
- Write the test first and watch it fail (RED) before the code exists; then make it pass.
- No wall-clock windows under ten seconds; wait on observable state.

## Commits

Conventional Commits with the requirement IDs in the subject or a `Refs:` trailer:

```
feat(core): evaluate scope constraints against call arguments (POL-2)

<why, not what>

Refs: POL-2, POL-8
```

Types: `feat`, `fix`, `test`, `refactor`, `docs`, `build`, `ci`, `chore`. The scope is the package or
app name. One logical change per commit, with its tests. Never commit secrets: development defaults live
in `.env.example` with obviously fake values.

## Database migrations

- Drizzle ORM with SQL migration files committed to the repository. Edit `packages/db/src/schema.ts`,
  then `pnpm --filter @aiops/db db:generate --name <name>` (add `--custom` for hand-written SQL).
- Forward-only; they run on start. Never edit or delete a migration that is on `main`; add a new one.
- A migration must be safe for running workflows and for several `api` and `worker` instances at once.
- The audit table is append-only: no update or delete path in code or migrations, except the retention
  mechanism. Change-sets are immutable after `prepared`; a change yields a new change-set and hash.

## Temporal workflow versioning

This is binding for every change under `apps/worker/src/workflows/`, `packages/temporal/src/contract.ts`,
activity signatures and `apps/worker/test/workflow-histories/`. Background: ADR 0006
([docs/decisions/0006-temporal-workflow-versioning.md](docs/decisions/0006-temporal-workflow-versioning.md))
and [docs/conventions/temporal-workflows.md](docs/conventions/temporal-workflows.md), which is the
source of this section.

- Workflow code is deterministic: no I/O, no wall-clock time, no randomness, no environment access, no
  Node built-ins, no imports from NestJS, Drizzle or adapters. Everything non-deterministic happens in
  activities.
- One workflow per change-set, workflow ID = change-set ID (EXE-1). Workflow inputs, signals and activity
  arguments carry identifiers only; item data is read from PostgreSQL inside activities (EXE-2).
- Activities are idempotent and safe to retry (EXE-4, NFR-2).
- **Versioning (EXE-10).** Any change that adds, removes, reorders or retypes a command (activity, timer,
  child workflow, signal, wait) in a workflow type that has ever been deployed, or changes an activity's
  name or argument shape, goes behind `patched(id)`. "It is only waiting at the signal" is not an
  exemption: the change is undetected there, and the waiting workflow silently runs new code. For a
  restructure too large to branch, add a new workflow type (`<name>V2`) and keep the old one registered
  until its last execution closes. Activity bodies need no patch.
- **Patch IDs:** `<workflow-type-kebab>-<what>-<yyyymmdd>`, one per change, never reused or renamed. Each
  carries a comment "remove not before <date>".
- **Lifecycle:** `patched` then `deprecatePatch`, only when no execution started before the patched
  deployment is open, and never earlier than change-set expiry plus the longest execution time after that
  deployment; removal only after those executions have left retention. Never skip a step, and never deploy
  `deprecatePatch` while workers with the pre-patch code still run. Once an execution has passed a patch
  marker, code without the `patched()` call cannot replay it, so check rollback before deploy. The
  `deprecatePatch` and removal steps were not exercised in the spike; test the first real use before
  relying on it.
- **The replay test is a CI gate:** `Worker.runReplayHistory` over every committed history in
  `test/workflow-histories/<workflowType>/*.json`. Required fixtures per type: one parked at each wait
  after at least one activity, one completed per code path, one per live patch marker, one failed or
  compensated. A change that adds a command adds a fixture recorded with the new code (`pnpm --filter
  @aiops/worker record-history <scenario>`); old fixtures are never regenerated to make a replay pass. The
  one exception: when a patch is removed, fixtures containing its marker are deleted or regenerated in the
  same change.
- **Activity results the workflow reads are part of its contract.** `changesetWorkflow` builds its activity
  options from the `inspect` result (`tuning`). Once the type is on `main`, a new field there must have a
  default in workflow code (an old history replays with the old result) or go behind `patched()`.
- Workflow types that have never been on `main` may have their fixtures re-recorded freely; from the first
  merge on, the rules above apply.
- Worker Deployments with pinned workflows are not used (ADR 0006).
- Never send signal or terminate input from the Temporal CLI or UI: the codec refuses plaintext payloads
  and the workflow can no longer be replayed.
- Payloads go through the encrypting data converter (SEC-4). Nothing sensitive in workflow history, search
  attributes or workflow IDs (SEC-3).
- Large change-sets use child workflows or continue-as-new (EXE-9) and stream items in pages (NFR-7).

## Public interfaces and versioning

Two interfaces are public and versioned (NFR-18): the `@aiops/connector-sdk` API and the configuration
schema. Their committed reports are the contract:

- `packages/connector-sdk/api-report.d.ts` (SDK API report);
- `packages/config/schema/aiops-config.v1.json` (configuration JSON Schema).

Regenerate after a change (the config report needs `pnpm build` first), and verify without writing with
`--check`:

```sh
node tooling/versioning/api-report.mjs connector-sdk
node tooling/versioning/api-report.mjs config
node tooling/versioning/api-report.mjs connector-sdk --check
```

CI runs the checks and the semver gate (`node tooling/versioning/semver-gate.mjs [--base <ref>]`), which
compares the reports with the base branch. Bump the version in the same change:

- no report diff: no bump needed;
- only additions: a higher minor (or major);
- any removal or change: a higher major.

The SDK version lives in `packages/connector-sdk/package.json` and equals `CONNECTOR_SDK_VERSION`; the
configuration schema version is `CONFIG_SCHEMA_VERSION`. Presets declare the SDK range they need in
`aiops.sdk`.

## Security issues

Do not report vulnerabilities in public issues or pull requests. Follow [SECURITY.md](SECURITY.md).

## License

The project is licensed under Apache 2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). By contributing
you agree that your contribution is licensed under the same terms. Every new source file starts with the
header (after a shebang, if any):

```
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
```

Shell scripts and Dockerfiles use the same two lines with `# `. Run `node tooling/license-headers.mjs`
to list files that lack it and add `--write` to add it.
