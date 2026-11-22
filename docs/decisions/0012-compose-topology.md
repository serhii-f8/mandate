# ADR 0012: Docker Compose topology

- Status: Accepted
- Date: 2026-11-16

## Context

Phase 1 needs `api`, `worker`, PostgreSQL, Temporal and Keycloak in Docker Compose
(NFR-9: one command, no Kubernetes, no proprietary cloud). NFR-13 asks for backup of
PostgreSQL "including the Temporal database", which assumes Temporal persists in
PostgreSQL. A fresh clone must start with one command and the repository may hold no
secrets.

## Options considered

1. **Temporal server:** `temporal server start-dev` (single binary, SQLite, what the
   Phase 0 experiments used); `temporalio/auto-setup` (schema setup built in);
   `temporalio/server` plus a one-shot `temporalio/admin-tools` schema job (Temporal's current
   reference Compose).
2. **Databases:** one PostgreSQL instance with a database per component; one
   PostgreSQL per component.
3. **Keycloak mode in Phase 1:** `start-dev` with its PostgreSQL database; `start`
   with TLS.
4. **One command:** `docker compose -f deploy/docker-compose.yml up`; a root
   `compose.yaml` that includes the deploy file so plain `docker compose up` works.
5. **Defaults without `.env`:** require copying `.env.example`; or defaults in the
   Compose file equal to `.env.example`.

## Decision

- `temporalio/server:1.32.2` on PostgreSQL, with an idempotent schema job and a
  namespace job on `temporalio/admin-tools:1.32.2`. The upstream setup script is not
  copied as is: its `create` step fails on a database that already exists, so ours
  checks first (second `up` must work).
- One `postgres:17` instance with databases `mandate`, `temporal`,
  `temporal_visibility`, `keycloak`, each with its own role, created by an init script.
- Keycloak `26.8.2` in `start-dev` for Phase 1, on its PostgreSQL database, with the
  two experimental features and the realm import. Production mode (`start`, TLS or a
  TLS-terminating proxy, [ADR 0004](0004-authorization-and-client-registration.md)) is a Phase 10 item for the installation guide.
- Root `compose.yaml` with `include: [deploy/docker-compose.yml]`; the command is
  `docker compose up -d --wait`.
- Every variable has a default in the Compose file equal to `.env.example`. All are
  development-only and visibly fake (`dev-only-…`). Host ports bind to `127.0.0.1`.

## Consequences

- `docker compose up` from a fresh clone needs nothing else; a `.env` in the repository
  root overrides any default.
- Temporal's database survives restarts, as later restart tests (NFR-1) need.
- Development defaults are guessable; an installation that exposes ports beyond
  `127.0.0.1` must set its own values. Phase 10 documents this.
- Temporal UI is not part of the default stack.

## Verified

2026-11-16:

- Docker Hub tags: `temporalio/server` 1.32.2 and `temporalio/admin-tools` 1.32.2
  (2026-11-02/03); `temporalio/auto-setup` newest 1.29.x / 1.23.1.1, i.e. no longer
  published for current servers.
- `https://github.com/temporalio/docker-compose` README: archived, moved to
  samples-server, which redirects to `temporalio/temporal-server-operations`;
  `compose/docker-compose-postgres.yml`, `compose/scripts/setup-postgres.sh`,
  `compose/scripts/create-namespace.sh`, `compose/dynamicconfig/development-sql.yaml`
  read (server env `DB=postgres12`, `POSTGRES_SEEDS`, `DB_PORT`, `POSTGRES_USER`,
  `POSTGRES_PWD`; schema via `temporal-sql-tool … setup-schema -v 0.0` and
  `update-schema -d /etc/temporal/schema/postgresql/v12/{temporal,visibility}/versioned`).
- The whole stack is exercised by
  [`scripts/acceptance/phase-1.sh`](../../scripts/acceptance/phase-1.sh).
