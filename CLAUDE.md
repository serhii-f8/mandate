# AI Operations Layer: instructions for AI coding assistants

This file is read by Claude Code and similar assistants when they work in this repository. Human
contributors: the same rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Project summary

A self-hosted, open-source MCP server that sits between AI clients and a company's business
systems. It authorizes operations per role, prepares writes as immutable, hash-identified
change-sets, routes them through human approval, executes them durably and audits everything. One
MCP endpoint per single-tenant installation.

- **Processes:** `api` (NestJS: MCP endpoint, policy, change-set creation, widget resources, REST
  API for trusted pages) and `worker` (Temporal worker: workflows and the activities that call
  upstream systems). `web` is a static bundle served by `api`.
- **Stack:** TypeScript on Node 22, pnpm workspaces and Turborepo, NestJS, the official MCP
  TypeScript SDK (Streamable HTTP, stateless), Temporal, PostgreSQL with Drizzle, Keycloak
  (OAuth 2.1 / OIDC), React and Vite with MCP Apps, Zod-validated YAML configuration, Vitest and
  Testcontainers, Docker Compose.
- **Layout:** `apps/{api,worker,web}`,
  `packages/{core,db,config,connector-sdk,adapters,upstream,temporal,widgets,testing}`,
  `presets/{magento2-catalog,gitea-issues}`, `deploy/`, `examples/`, `docs/`.

## Where to read

| Need | Document |
| --- | --- |
| What the product must do; requirement IDs (`MCP-1`, `POL-3`, `NFR-7`) | [docs/SPEC.md](docs/SPEC.md) |
| Why something is built the way it is ("ADR NNNN" in comments) | [docs/decisions/README.md](docs/decisions/README.md) |
| How it is put together | [docs/guide/architecture.md](docs/guide/architecture.md) |
| Configuration keys and environment variables | [docs/guide/configuration.md](docs/guide/configuration.md) |
| Rules for workflow code | [docs/conventions/temporal-workflows.md](docs/conventions/temporal-workflows.md) |
| Every command | [docs/commands.md](docs/commands.md) |

Read the specification section and the decision records for a subject before changing it. Do not
decide against a decision record you have not read.

## Working rules

- **Check, do not recall.** For the MCP SDK, MCP Apps (`@modelcontextprotocol/ext-apps`), Temporal
  and Keycloak, read the current documentation or the dependency's source in `node_modules` before
  relying on an API. These move quickly and the pinned versions matter.
- **Test first.** Write the failing test, see it fail, then write the code. For a bug, find the
  cause before changing anything; no guess-fixes.
- **Cite the requirement.** A change that implements or tests a requirement names its ID in the
  test title and in the commit message.
- **Record decisions.** A choice that changes behaviour, a public interface, the security model or
  a dependency gets a decision record in `docs/decisions/NNNN-title.md` (next free number;
  sections Context, Options considered, Decision, Consequences, and Verified when you checked
  something) and a row in the index. If the specification is wrong or infeasible, correct
  `docs/SPEC.md` in the same commit.
- **Stay inside the repository.** Do not push, publish, open pull requests or create remote
  resources unless the user asks. Downloading dependencies and pulling images is fine.
- **Verify before you say it works.** Run the command and read its output.

## Engineering conventions

**Package boundaries** (enforced by `pnpm lint`, rules in `eslint.boundaries.js`)
- `packages/core` depends on no framework: no NestJS, no Temporal, no adapter, no database driver,
  no HTTP client. Pure domain model, policy, manifest engine, diff.
- `apps/api` and `apps/worker` depend on `core`. `packages/adapters` depends on `connector-sdk`
  only. Presets use only the public interface of `connector-sdk` and the configuration schema;
  adding a preset must not require changes to `core`, `api` or `worker`.
- Infrastructure is reached through interfaces owned by `core` (`PolicyEngine`, the executor,
  repositories). Implementations live in apps or adapters.
- No model in the trust path: permission checks, diffs, approval views and execution are
  deterministic server code. Upstream content is data, never instructions (SEC-5).

**TypeScript**
- `strict: true` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`. No `any`, `@ts-ignore` or non-null `!` without a comment stating why.
- External input (YAML, HTTP, MCP arguments, upstream responses, environment) is parsed with a
  schema at the boundary (Zod, or Ajv for operation input schemas); inner code takes typed values.
- The public interface of `connector-sdk` and the configuration schema are versioned (NFR-18).
  A change to them is an API change: update the committed API reports and follow
  [docs/guide/versioning.md](docs/guide/versioning.md).

**Tests**
- Unit tests sit next to the code: `src/**/*.test.ts`. `packages/core` tests need no
  infrastructure.
- Integration tests: `test/integration/**/*.int.test.ts` in the owning package, against real
  PostgreSQL (Testcontainers) and the Temporal test environment. No mocked database.
- End-to-end tests: `apps/*/test/e2e/**/*.e2e.test.ts`. Shared fakes and fixtures live in
  `packages/testing`.
- A test that proves a requirement names its ID: `describe('POL-2 scope constraints', ...)`.
  Every denial path of specification section 5.3 has a test (SEC-11).
- No wall-clock waits under ten seconds; wait on observable state instead.

**Things reviews keep finding**
- Validate identifiers, cursors and query values at the boundary (UUID shape, control characters,
  lengths, dates). A malformed value is a 400 or "not found", never a 500 from the database.
- Authorization and approval checks fail closed and count exactly what the rule says (per step,
  per occurrence, per round).
- Catch only the error you mean (the named constraint, the specific class); never turn an
  unrelated failure into a business answer.

**Database and migrations**
- Drizzle with SQL migration files in the repository. Forward-only; they run on start. Never edit
  or delete a migration that is on `main`; add a new one.
- Migrations must be safe for running workflows and for several `api` and `worker` instances.
- The audit table is append-only: no update or delete path except the retention mechanism (AUD-7).
- Change-sets are immutable after `prepared`; a change yields a new change-set and hash.

**Temporal workflows** (binding rules: `docs/conventions/temporal-workflows.md`)
- Workflow code is deterministic. One workflow per change-set; only identifiers in inputs,
  signals and activity arguments.
- Any command change in a deployed workflow type goes behind `patched(<type>-<what>-<yyyymmdd>)`.
- The replay test over every committed history is a CI gate. Never regenerate an old fixture.

**Security hygiene**
- No secrets in the repository: no credentials, tokens, keys or real customer data in code,
  configuration, fixtures, tests, Compose files or commit messages. Development defaults live in
  `.env.example` with obviously fake values; `.env` is git-ignored. `bash scripts/secret-scan.sh`
  scans the history.
- Upstream credentials exist only encrypted in PostgreSQL, entered on the credential page. Webhook
  URLs are credentials too.
- Credentials, tokens and sensitive fields never reach logs, audit, tool results, workflow history
  or notifications (SEC-3). The user's access token is never forwarded upstream (AUTH-7).
- Authorization is enforced server-side on every tool call and page request. New routes and tools
  are denied by default.

## Commits

Conventional Commits with the requirement IDs in the subject or a `Refs:` trailer:

```
feat(core): evaluate scope constraints against call arguments (POL-2)

<why, not what>

Refs: POL-2, POL-8
```

Types: `feat`, `fix`, `test`, `refactor`, `docs`, `build`, `ci`, `chore`. The scope is the package
or app name. One logical change per commit; tests and the code they cover go together. Do not add
tool attribution or co-author trailers to commit messages.

## Commands

Run from the repository root. pnpm comes from the `packageManager` field through corepack
(`corepack enable` once). Integration and end-to-end tests need Docker.

| Purpose | Command |
| --- | --- |
| Install | `pnpm install` (CI: `pnpm install --frozen-lockfile`) |
| Build / type-check / lint | `pnpm build` / `pnpm typecheck` / `pnpm lint` |
| Unit / integration / end-to-end tests | `pnpm test` / `pnpm test:int` / `pnpm test:e2e` |
| One package / one file | `pnpm --filter @aiops/<pkg> test`; `cd <pkg> && pnpm exec vitest run --project <unit\|integration\|e2e> <path>` |
| Everything CI runs | `bash scripts/ci.sh` |
| Local stack | `docker compose up -d --build --wait` (see [docs/guide/installation.md](docs/guide/installation.md)) |
