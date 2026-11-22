# Service accounts

A service account is a non-interactive client, such as a CI job, that calls the MCP endpoint with a
token from the OAuth client credentials grant. It maps to exactly one role. It sees that role's
tools, its calls are checked and audited, and its writes go through the same change-sets as a
person's.

## Create the client in Keycloak

The bundled Keycloak creates one confidential client for each ID in `MANDATE_KEYCLOAK_SERVICE_ACCOUNTS`
(comma-separated) when the stack starts. The development default is `mandate-sa-ci`. The client has
the client credentials grant only: no browser login, no password grant. Keycloak generates its
secret.

```bash
MANDATE_KEYCLOAK_SERVICE_ACCOUNTS=mandate-sa-ci,nightly-sync
```

Set the variable in `.env` and run `docker compose up -d` again, which runs the setup job; it is
idempotent and keeps the existing secrets. In production leave it empty unless you use service accounts
([Production hardening](production.md)). A client ID that the realm already uses is refused.

Read the secret in the Keycloak admin console (Clients, the client, Credentials). Store it in your
job's secret store. Never put it in the platform's configuration or a repository. Request a token
with the grant and the MCP resource, which makes `aud` exactly the MCP URL. `KEYCLOAK_URL` (the
public Keycloak address, `http://localhost:8480` in development) and `CLIENT_SECRET` are
placeholders: set them in your shell or job first, without echoing the secret. The command keeps
the access token in a variable and prints nothing. The secret reaches curl on standard input
(`printf` is a shell builtin), so it never appears on a command line that other users can see
with `ps`:

```bash
ACCESS_TOKEN="$(printf '%s' "$CLIENT_SECRET" | curl -s -X POST "$KEYCLOAK_URL/realms/mandate/protocol/openid-connect/token" \
  -d grant_type=client_credentials \
  -d client_id=nightly-sync \
  --data-urlencode client_secret@- \
  -d resource="$MANDATE_MCP_RESOURCE" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).access_token??""))')"
test -n "$ACCESS_TOKEN"
```

Send `$ACCESS_TOKEN` as a bearer token to the MCP URL. Tokens are short
lived and there is no refresh token: request a new one when it expires.

## Map the client to a role

Add `service_accounts` to a configuration file. `client_id` is the OAuth client ID, and `role` is one
role:

```yaml
service_accounts:
  - client_id: nightly-sync
    role: integration
    description: Nightly catalog sync
    rate_limit_per_minute: 120
roles:
  - id: integration
    grants:
      - { operation: catalog.get_products }
      - { operation: catalog.update_content, scope: { brand: [acme] } }
    approval: { required: always, steps: [{ role: content_lead }] }
```

`client_id` must be unique. The role's grants decide what the account can do, and the Keycloak
groups of a service account are ignored. A client that is not listed here has no role: its calls
are denied. A token whose `azp` is a listed client but which carries a user session is rejected and
audited.

Check what the account may do without calling anything:

```bash
docker compose exec -T api node dist/cli.js config explain --operation catalog.get_products --service nightly-sync
```

`--service` and `--groups` are mutually exclusive. Exit code 0 means allowed.

## Rate limit override

Every service account shares the default `rate_limits.mcp_service_account_per_minute` (600
requests per minute at the MCP endpoint, each account counted separately). Set
`rate_limit_per_minute` (1 to 100000) on an entry to give one account its own limit, higher or
lower. See `rate_limits` in the [Configuration reference](configuration.md). A request over the
limit is refused with HTTP 429 and a `Retry-After` header.

## Why its writes still need a human

A service account is a requester, not an approver. Its writes are prepared as change-sets and follow
the approval rule of its role. Set `approval.required: always` (or `above_threshold`) with at least
one step, as above, and a person who holds the step role approves the change on the trusted page
before anything is written. The account itself:

- never sees `review_changeset` or `decide_changeset`, and cannot approve, even its own change;
- has no browser session, so it cannot open trusted pages, enter credentials or confirm a rollback;
- appears in the audit trail and as the requester as `service:<client_id>`.

An approval rule of `required: never` lets a service account's writes run without a human. That is
an explicit choice you make on the role, so make it only for changes you would accept unreviewed.
The loader refuses a `write_opaque` grant without approval steps unless you set `never`.

## Background

- [ADR 0050](../decisions/0050-mcp-upstream-opaque-presets-service-accounts.md): why service
  accounts are identified by `azp` and mapped to one role.
- [ADR 0051](../decisions/0051-mcp-upstream-opaque-presets-service-accounts-details.md): the `service:<client_id>` subject and the
  client credentials rule.
