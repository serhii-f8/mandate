# Production hardening

The shipped Compose file is a development stack: fake passwords, a development Keycloak, plain HTTP on
localhost. Work through this checklist before real users or real data reach it. The values come from
`.env.example`; the full list of variables is in the [Configuration reference](configuration.md).

## 1. Replace every development secret

- Every value that starts with `dev-only-` must change: `AIOPS_WEB_CLIENT_SECRET`,
  `POSTGRES_SUPERUSER_PASSWORD`, `AIOPS_DB_PASSWORD`, `TEMPORAL_DB_PASSWORD`, `KEYCLOAK_DB_PASSWORD`,
  `KEYCLOAK_ADMIN_PASSWORD`. Use long random values.
- `AIOPS_MASTER_KEYS` (credential vault) and `AIOPS_TEMPORAL_KEYS` (workflow payloads) ship with fake keys.
  Generate real ones:

  ```bash
  openssl rand -base64 32
  ```

  Each entry is `<id>:<that value>`, for example `1:<value>`. Keep these keys outside the repository and
  back them up separately from the database: without them credentials and workflow history cannot be
  read.
- Keep `.env` out of version control and readable by the deploying account only. Backups never contain
  it.

## 2. Close the CI service account

The bootstrap creates a Keycloak service-account client for the repository's acceptance scripts, `aiops-sa-ci`. Production does
not need it. Set the variable to empty:

```
AIOPS_KEYCLOAK_SERVICE_ACCOUNTS=
```

An empty value creates no service-account client. Set it to a list of client IDs only for service
accounts you actually use (see [Service accounts](service-accounts.md)). If the stack already ran with
the default, the client exists in the realm: delete it in the Keycloak administration console.

## 3. Keycloak in production mode

The shipped Compose runs Keycloak with `start-dev`. For production run Keycloak in production mode,
with TLS, a real hostname and its own database credentials, following Keycloak's server guide. Then:

- Set `AIOPS_KEYCLOAK_PUBLIC_URL` to the public HTTPS URL. The access tokens' issuer is derived from it
  (`OIDC_ISSUER`).
- Keep dynamic client registration off: `AIOPS_DCR=off`. Anonymous registration lets any client create
  an OAuth client. Clients such as Claude identify themselves with client ID metadata documents from
  the domains in `AIOPS_CIMD_CLIENT_DOMAINS`; leave that list at the domains you intend to admit. Remove
  `localhost,127.0.0.1` from `AIOPS_CIMD_EXTRA_DOMAINS` and `AIOPS_DCR_REDIRECT_HOSTS`.
- Delete the development users (alice, bob, carol, dave) and map your own groups with `role_mapping`.

## 4. TLS, hostname and the reverse proxy

Put a reverse proxy with TLS in front of the `api`. Then set:

| Variable | Value |
| --- | --- |
| `AIOPS_PUBLIC_URL` | The public origin, for example `https://aiops.example.com` |
| `AIOPS_MCP_RESOURCE` | `<public origin>/mcp`; the audience of access tokens |
| `API_ALLOWED_HOSTS` | The host names clients use, comma-separated; requests with another `Host` or `Origin` are refused |
| `AIOPS_TRUST_PROXY` | `1` behind one proxy; the number of proxy hops you run, never more |

`AIOPS_TRUST_PROXY` decides how far `X-Forwarded-For` is trusted when the api works out the client
address for rate limits. A value higher than your real hop count lets a client choose the address the
limiter sees. Publish the ports of PostgreSQL, Temporal and the metrics endpoints to nobody; Compose binds
the published ports to `127.0.0.1` for this reason.

## 5. Rate limits

Defaults are 300 requests per minute per user, 600 per service account and 60 per client address for
unauthenticated requests. Tune them in the `rate_limits` configuration block and per service account with
`rate_limit_per_minute`. See the [Configuration reference](configuration.md).

## 6. Mail and notifications

Mailpit is a development mail sink. Point `AIOPS_SMTP_URL` at a real relay and set `AIOPS_MAIL_FROM`.
Webhook URLs are credentials: enter them on the credential page, never in configuration.

## 7. Backups and the audit archive

- Schedule the backup in [Backup and restore](backup-and-restore.md) and test a restore.
- If you set `audit.retention_days`, set `AIOPS_AUDIT_ARCHIVE_DIR` to a writable absolute path on a volume
  that is backed up. Retention refuses to run without it.

## 8. Monitoring

Scrape the metrics endpoints, collect the JSON logs, and export traces. See [Operations](operations.md).
Alert on `/readyz` failing and on change-sets stuck waiting.

## 9. Pin images by digest

Tags move. Pin every image in your Compose file by digest so a restart cannot pull something you have not
reviewed. List the images, resolve each tag, and write `image: name:tag@sha256:...`:

```bash
docker compose config --images
docker buildx imagetools inspect postgres:17
```

Build the `api` and `worker` images once in your pipeline, push them to your own registry and reference
them by digest as well. Update digests deliberately, as part of an upgrade (see [Upgrading](upgrading.md)).

## 10. Restrict who may do what

- Give `view_audit` and `manage_credentials` only to roles that need them.
- Keep `approval.allow_widget` at `false` for roles whose approvals should happen on the trusted page.
- Review the roles with `config explain` before each `config apply` (see
  [Roles and approvals](roles-and-approvals.md)).
