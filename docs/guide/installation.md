# Installation

This page starts the full development stack on one machine: the `api` and `worker` processes,
PostgreSQL, Temporal and Keycloak, with a development configuration and a development realm.
For a real installation read [production.md](production.md) as well.

## Prerequisites

- Docker Engine with Compose v2.
- 4 CPU cores and 8 GB RAM for the stack plus the Magento sandbox used in later pages.
- git.
- Node 22 with corepack, only if you use the terminal client scripts from later pages.

## Install

Clone the repository and start the stack from its root. The first run builds the images.

```bash
git clone <repository-url> ai-operations-layer
cd ai-operations-layer
```

<!-- doc-test: install -->
```bash
docker compose up -d --build --wait
```

This starts `api`, `worker`, PostgreSQL, Temporal, Keycloak and Mailpit (a development mail sink).
Migrations run on start, and the development configuration in `deploy/config/` seeds the first
active revision. All ports are bound to `127.0.0.1`.

The host ports are 8400 (api), 8480 (Keycloak), 17233 (Temporal), 15432 (PostgreSQL) and 8025
(Mailpit). Check them before the first start, because the build runs first and a clash shows only
after it, for example with `ss -ltn` on Linux or `lsof -nP -iTCP -sTCP:LISTEN` on macOS. If one is
taken by another program, `up` fails with `port is already allocated`: pick a free port as described
in [Change the defaults](#change-the-defaults) and run `up` again. The
Compose project is always called `aiops`, so a second clone on the same machine shares its
containers and volumes; run one copy at a time.

## Check health

<!-- doc-test: install -->
```bash
curl -fsS "http://localhost:${AIOPS_API_PORT:-8400}/readyz"
```

`/readyz` answers 200 once the database is reachable and a configuration is active.

## Where things are

| What | URL |
| --- | --- |
| MCP endpoint | `http://localhost:8400/mcp` |
| Approval queue (trusted page) | `http://localhost:8400/app/approvals` |
| Credential page | `http://localhost:8400/app/credentials` |
| Audit page | `http://localhost:8400/app/audit` |
| Keycloak | `http://localhost:8480` |
| Mailpit (development mail) | `http://localhost:8025` |

## Development users

The bundled Keycloak realm has four users. Every password is `dev-only-password`; these exist
for development only and must never be used in a real installation.

| User | Groups | Role through the development mapping |
| --- | --- | --- |
| alice | `/content`, `/content-leads` | content manager and content lead |
| bob | `/support` | support agent |
| carol | `/admins` | integration admin |
| dave | `/content-leads` | content lead (approves large changes) |

The Keycloak administrator is `admin` with the password from `KEYCLOAK_ADMIN_PASSWORD` in
`.env.example`.

## Change the defaults

Copy `.env.example` to `.env` and edit it; Compose reads `.env` from the repository root. You can
change the host ports (`AIOPS_API_PORT`, `AIOPS_KEYCLOAK_PORT`, `AIOPS_TEMPORAL_PORT`,
`AIOPS_POSTGRES_PORT`, `AIOPS_MAILPIT_PORT`) and the public URLs that must follow them
(`AIOPS_KEYCLOAK_PUBLIC_URL`, `AIOPS_MCP_RESOURCE`, `AIOPS_PUBLIC_URL`). Every secret in the file
is a development fake. If you change the api or Keycloak port, change its URLs too
(`AIOPS_PUBLIC_URL` and `AIOPS_MCP_RESOURCE` follow `AIOPS_API_PORT`, `AIOPS_KEYCLOAK_PUBLIC_URL`
follows `AIOPS_KEYCLOAK_PORT`); the other ports have no URL setting. The URLs on these pages show
the default ports: use yours instead.

## Stop

```bash
docker compose down        # stop, keep the data
docker compose down -v     # stop and delete all data
```

After the walkthrough, `down -v` gives you a clean start next time; use `down` to keep the
configuration, credential and change-sets.

These commands stop only this stack. The Magento sandbox of the next page is a separate Compose
project and keeps running; stop it with `bash deploy/sandbox/magento/down.sh` (add `-v` to delete
the shop's data; the next start reinstalls it). If a sandbox is already running, for example from
another clone, the next page's `up.sh` reuses it. The walkthrough leaves its new keywords on the acme products until you roll the
change back or reset the sandbox.

## Next

[Connecting Magento](connecting-magento.md).
