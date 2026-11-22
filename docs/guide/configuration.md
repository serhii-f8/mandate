# Configuration reference

Two things configure an installation. YAML files describe what the system may do: connections,
operations, roles and limits. Environment variables describe how the `api` and `worker` processes
run: ports, database, keys. This page lists every key and variable with its type, default and
bounds. The values come from the schema in `packages/config/src/schema.ts` and from
`packages/config/src/runtime-env.ts`; a machine-readable JSON Schema is published at
`packages/config/schema/mandate-config.v1.json`.

For the workflow (check, apply, revisions) see [Roles and approvals](roles-and-approvals.md). For
production values see [Production hardening](production.md).

## YAML files

- A configuration is a directory (`MANDATE_CONFIG_DIR`) of `.yaml` files. Each file is one document
  and must start with `version: 1`.
- Every object is strict: an unknown key is an error, so a typo or a pasted secret does not pass
  silently. Only `input_schema` and the `args` of a connection test are open objects.
- List keys (`connections`, `operations`, `roles`, `role_mapping`, ...) concatenate across files.
  An `id` may appear once across all files.
- `changesets`, `audit` and `rate_limits` may be set in one file only.
- Credentials never go in YAML. A connection names a secret with `credential_ref`; you enter the
  value on the credential page. A URL with a user name or password is refused.
- `id` values match `^[a-z][a-z0-9_-]{0,62}$`. Operation IDs match
  `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` with at most 64 characters; they are also the MCP tool names.

### Top-level keys

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `version` | the number `1` | required | Schema version of the document |
| `connections` | list | none | Upstream systems |
| `operations` | list | none | What may be called on a connection |
| `roles` | list | none | Grants, limits and approval rules |
| `role_mapping` | list | none | Keycloak group to roles |
| `service_accounts` | list | none | OAuth clients that call as a role |
| `presets` | list | none | Preset packages that supply operations |
| `notifications` | list | none | E-mail and webhook targets |
| `overrides` | list | none | Tool name, texts and enabling of an operation |
| `changesets` | object | see below | Change-set lifecycle |
| `audit` | object | keep forever | Audit retention |
| `rate_limits` | object | see below | Endpoint rate limits |

### `version`

```yaml
version: 1
```

### `connections`

Each entry has `adapter: openapi` or `adapter: mcp`.

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| `id` | id | required | Unique |
| `adapter` | `openapi` or `mcp` | required | |
| `base_url` | http(s) URL | required for `openapi` | No user name or password |
| `openapi.spec` | URL or path | none | http(s) URL, or a file path relative to the file; 1-2048 characters |
| `openapi.include` | list of strings | none | At least 1 entry; each 1-512 characters |
| `mcp_url` | http(s) URL | required for `mcp` | |
| `pin_check_seconds` | integer | 300 | 10-86400; `mcp` only; seconds between checks of the pinned tools |
| `credential_ref` | id | none | Required when `auth` is set; refused without `auth` |
| `auth.scheme` | `bearer`, `api_key`, `basic`, `oauth_client_credentials`, `oauth_password` | none | `oauth_password` since 1.1.0: the OAuth password grant, for upstreams that offer nothing else (OAuth 2.1 removes the grant). Secret: `client_id`, `client_secret`, `username`, `password` |
| `auth.header` | header name | required for `api_key` | |
| `auth.token_url` | http(s) URL | required for `oauth_client_credentials` and `oauth_password` | Its host joins the connection's allowed hosts |
| `auth.scopes` | list of strings | `[]` | `oauth_client_credentials` and `oauth_password` |
| `auth.client_auth` | `basic`, `body` | `basic` | `oauth_password` only; since 1.1.0. `basic`: client id and secret in a Basic header. `body`: as form fields, for token endpoints that do not accept the header |
| `preset` | id | none | Names an entry of `presets` |
| `operation_prefix` | string | none | `^[a-z][a-z0-9_]{0,30}$`; requires `preset` |
| `timeout_ms` | integer | 10000 | 1-120000 |
| `retry.max_attempts` | integer | 3 | 1-10 |
| `retry.initial_backoff_ms` | integer | 200 | 0-60000 |
| `max_concurrency` | integer | 4 | 1-1000 |
| `rate.requests_per_second` | number | none (unpaced) | 0.01-1000; since 1.1.0. Requests of the connection start at least `1000 / value` ms apart, retries included; per process |
| `allow_private_network` | boolean | `false` | Allows private and loopback addresses |
| `test.operation` | operation ID | none | The read operation of the connection test |
| `test.args` | object | `{}` | Arguments of the test call |

```yaml
connections:
  - id: shop
    adapter: openapi
    base_url: https://shop.example.test/rest/all
    credential_ref: shop_token
    auth: { scheme: bearer }
    timeout_ms: 15000
    retry: { max_attempts: 3, initial_backoff_ms: 200 }
    test: { operation: catalog.get_product, args: { sku: SAMPLE } }
```

### `operations`

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| `id` | operation ID | required | Also the tool name |
| `connection` | id | required | Names a connection |
| `risk` | `read`, `write`, `write_opaque`, `destructive` | required | |
| `title` | string | none | 1-200 characters |
| `description` | string | required | 1-2000 characters |
| `upstream` | object | required | See below |
| `input_schema` | JSON Schema object | derived from the spec | Open object; required when `upstream` uses templates |
| `fields_arg` | string | none | 1-128 characters; the argument that selects returned fields; for a write it must equal `manifest.values_arg` |
| `manifest` | object | none | Required for `write`; allowed on `destructive`; not allowed on `read` or `write_opaque` |

`upstream` takes one of three forms, chosen by its keys:

- HTTP mapping: either `operation` (an operation of the OpenAPI spec) or `method`
  (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) with `path` (starts with `/`). Optional `path_params`,
  `query`, `headers` and `body` take literals, `{ arg: name, default, join }` or
  `{ record: name, default, join }`. Optional `response` has `items`, `total`, `flatten`,
  `fields_from_arg` and `max_items` (1-500, default 100). `bulk` (not together with `body`) maps a
  bulk endpoint: `batch_id`, `body.wrap`, `body.nest`, and `status` with `path` (contains only
  `{batch_id}`), `items`, `index` or `key` (exactly one), `state` and `states` lists `ok`,
  `retriable`, `failed`, `open`. `idempotency.header` names the idempotency header of a
  `write_opaque` operation and may not be a header the platform sets.
- MCP: `{ tool, pin }` on an `mcp` connection. See [MCP upstreams](mcp-upstreams.md).
- Code: `{ code: name, response }` for an operation served by a preset's code module.

`manifest` describes how a write is prepared:

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| `id_field` | string | required | |
| `ids_arg` | string | none | Give `ids_arg`, `selector` or both |
| `values_arg` | string | required | A required object property of `input_schema` with `additionalProperties: false` |
| `fields` | list | required | At least 1 |
| `required_fields` | list | `[]` | |
| `sensitive_fields` | list | `[]` | Each must be in `fields`; the audit trail redacts their values |
| `scope_args` | map | `{}` | Scope name to argument name |
| `read_before` | object | required | `operation`, `ids_arg`, `args` |
| `selector` | object | none | `operation`, `args`, `page_arg`, `page_size_arg`, `page_size` (1-1000, default 100) |
| `write.carry_fields` | list | none | At least 1 |
| `batch_size` | integer | 100 | 1-1000 |
| `max_targets` | integer | 10000 | 1-100000 |
| `rollback` | object | required | `strategy: replay_previous_state`, `none`, or `inverse_operation` with `operation` |

```yaml
operations:
  - id: catalog.update_products
    connection: shop
    risk: write
    description: Update fields on products.
    upstream: { method: PUT, path: /V1/products/{sku}, path_params: { sku: { record: sku } } }
    manifest:
      id_field: sku
      ids_arg: skus
      values_arg: changes
      fields: [name, meta_keyword]
      read_before: { operation: catalog.get_products, ids_arg: skus, args: {} }
      rollback: { strategy: replay_previous_state }
```

The `read_before` operation must be an enabled read operation that declares `fields_arg`; that
argument must be a required property of its `input_schema` and equal `upstream.response.fields_from_arg`.
A grant
`scope` key must be an argument of the operation and, for a write with a manifest, a key of
`manifest.scope_args`.

### `roles`

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| `id` | id | required | |
| `description` | string | none | Up to 2000 characters |
| `grants` | list | required | May be empty |
| `grants[].operation` | operation ID | required | |
| `grants[].id` | id | none | Unique in the role |
| `grants[].scope` | map of name to list | `{}` | Each list has at least 1 string, number or boolean |
| `grants[].deny_fields` | list | `[]` | Needs `fields_arg` on the operation |
| `grants[].allow_fields` | list | none | Needs `fields_arg` on the operation |
| `limits.records_per_operation` | integer | none | At least 1 |
| `limits.records_per_day` | integer | none | At least 1 |
| `limits.calls_per_minute` | integer | none | At least 1 |
| `limits.concurrent_executions` | integer | none | At least 1 |
| `approval.required` | `always`, `never`, `above_threshold` | none | |
| `approval.record_threshold` | integer | none | At least 1; required with, and only with, `above_threshold` |
| `approval.steps` | list of `{ role }` | none | 1-5 steps; each role must exist |
| `approval.step_up_max_age_seconds` | integer | none | 30-3600 |
| `approval.allow_widget` | boolean | `false` | Approve from the in-chat widget |
| `manage_credentials` | list | none | Credential references, or `*` for all |
| `view_audit` | boolean | `false` | Read the audit trail and export |
| `notify.approval_requests` | list of notification IDs | `[]` | Told when an approval step of this role becomes current |
| `notify.results` | list of notification IDs | `[]` | Told of results |

```yaml
roles:
  - id: content_editor
    grants:
      - operation: catalog.update_products
        deny_fields: [price]
    limits: { records_per_day: 500 }
    approval:
      required: above_threshold
      record_threshold: 25
      steps: [{ role: content_lead }]
```

### `role_mapping`

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| `group` | string | required | Keycloak group, 1-255 characters |
| `roles` | list of ids | required | At least 1 |

```yaml
role_mapping:
  - { group: content, roles: [content_editor] }
```

### `service_accounts`

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| `client_id` | string | required | 1-255 characters, no control characters; appears once |
| `role` | id | required | Exactly one role |
| `description` | string | none | Up to 500 characters |
| `rate_limit_per_minute` | integer | none | 1-100000; overrides `rate_limits.mcp_service_account_per_minute` for this client |

See [Service accounts](service-accounts.md).

### `presets`

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| `id` | id | required | |
| `package` | string | required | 1-214 characters |
| `version` | string | none | Semver range, up to 64 characters |

See [Presets](presets.md).

### `notifications`

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| `id` | id | required | |
| `kind` | `email` or `webhook` | required | |
| `to` | list of e-mail addresses | required for `email` | At least 1 |
| `url_credential_ref` | id | required for `webhook` | A credential of scheme `webhook_url`; the URL is entered on the credential page, never here |
| `allowed_hosts` | list of host names | required for `webhook` | Lower-case host or IPv4 address without port; up to 253 characters each |
| `allow_private_network` | boolean | `false` | `webhook` only |

### `overrides`

Applied after presets.

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| `operation` | operation ID | required | |
| `tool_name` | operation ID shape | none | |
| `title` | string | none | 1-200 characters |
| `description` | string | none | 1-2000 characters |
| `enabled` | boolean | `true` | `false` leaves the operation out of the enabled set: it is not offered or callable, and a connection test cannot name it |

### `changesets`

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| `expire_after_hours` | number | 72 | 1/60 to 2160 |
| `failure_threshold` | number | 0.5 | Above 0, up to 1; share of failed items that stops execution |
| `items_per_workflow_run` | integer | 2000 | 100-1000000 |
| `rollback_window_hours` | number | 168 | 0-2160; 0 disables rollback |

### `audit`

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| `retention_days` | integer | none (keep forever) | 1-36500; needs `MANDATE_AUDIT_ARCHIVE_DIR` to run |

### `rate_limits`

Requests per minute at the MCP endpoint and for unauthenticated requests (SEC-10). Each value is a
whole number from 1 to 100000. Absent keys take the defaults.

| Key | Default | Applies to |
| --- | --- | --- |
| `mcp_user_per_minute` | 300 | Each signed-in user |
| `mcp_service_account_per_minute` | 600 | Each service account (see `rate_limit_per_minute` to override) |
| `unauthenticated_per_minute` | 60 | Requests without a valid token, per client address |

The client address comes from `X-Forwarded-For` only as far as `MANDATE_TRUST_PROXY` allows.

```yaml
rate_limits:
  mcp_user_per_minute: 300
  unauthenticated_per_minute: 30
```

## Environment variables

Variables are parsed at start. An invalid value stops the process and the error names the variable
and the reason, never the value. `.env.example` holds development defaults for Compose; Compose
passes them to the containers, sometimes under another name (for example `MANDATE_WEB_CLIENT_SECRET`
becomes `OIDC_WEB_CLIENT_SECRET`).

### `api`

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | required | `postgres://` or `postgresql://` URL |
| `API_PORT` | 8080 | 1-65535 |
| `API_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Comma-separated Host and Origin names accepted on MCP requests |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `MANDATE_CONFIG_DIR` | required | Directory of YAML files |
| `MANDATE_MCP_RESOURCE` | required | Canonical URL of the MCP endpoint; token audience; no fragment |
| `OIDC_ISSUER` | required | Expected `iss` of access tokens |
| `OIDC_JWKS_URL` | required | Where the api fetches signing keys; may be an internal URL |
| `MANDATE_PUBLIC_URL` | required | Origin without path, query or fragment; base of page and callback URLs |
| `OIDC_WEB_CLIENT_ID` | `mandate-web` | Client of the trusted-page login |
| `OIDC_WEB_CLIENT_SECRET` | required | Secret of that client |
| `OIDC_AUTHORIZATION_URL` | `<issuer>/protocol/openid-connect/auth` | Browser-facing |
| `OIDC_TOKEN_URL` | `<issuer>/protocol/openid-connect/token` | Called by the api; may be internal |
| `MANDATE_MASTER_KEYS` | required | Credential vault keys, `<id>:<base64 of 32 bytes>`, comma-separated |
| `MANDATE_SESSION_MAX_AGE_SECONDS` | 28800 | At least 1 |
| `MANDATE_FRESH_AUTH_SECONDS` | 300 | At least 1; how recent a login must be to store a credential |
| `MANDATE_WEB_DIR` | none | Directory of the built web bundle |
| `MANDATE_WIDGET_DIR` | development location | Directory of the widget bundles |
| `MANDATE_PRESET_DIRS` | none | Colon-separated preset directories |
| `TEMPORAL_ADDRESS` | `localhost:7233` | |
| `TEMPORAL_NAMESPACE` | `default` | |
| `TEMPORAL_TASK_QUEUE` | `mandate-operations` | |
| `MANDATE_TEMPORAL_KEYS` | required | Payload encryption keys, `<version>:<base64 of 32 bytes>`; the highest version encrypts |
| `MANDATE_PREPARE_WAIT_MS` | 20000 | 0-300000; how long a write call without Tasks waits for its preparation |
| `MANDATE_AUDIT_ARCHIVE_DIR` | none | Absolute path; unset keeps audit rows |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none | OTLP/HTTP collector URL; empty or unset disables trace export |
| `MANDATE_METRICS_PORT` | 9464 | 0-65535; 0 picks a free port; a blank value means the default |
| `MANDATE_TRUST_PROXY` | 0 | 0-10 |

`MANDATE_TRUST_PROXY` (SEC-10) is the number of proxy hops in front of the api whose
`X-Forwarded-For` is trusted when the api works out the client address for rate limits. 0 trusts
none, so the address is the socket peer. Set 1 behind one reverse proxy. Never set more hops than
you run: with too high a value a client can send its own `X-Forwarded-For` and choose the address
the limiter sees.

### `worker`

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | required | As for the api |
| `LOG_LEVEL` | `info` | |
| `MANDATE_CONFIG_DIR` | required | The worker loads the same configuration |
| `MANDATE_PRESET_DIRS` | none | |
| `MANDATE_MASTER_KEYS` | required | Same keys as the api |
| `MANDATE_TEMPORAL_KEYS` | required | Same keys as the api |
| `TEMPORAL_ADDRESS` | `localhost:7233` | |
| `TEMPORAL_NAMESPACE` | `default` | |
| `TEMPORAL_TASK_QUEUE` | `mandate-operations` | |
| `MANDATE_PREPARE_TIMEOUT_MS` | 3600000 | Positive integer; must be greater than 60000 |
| `MANDATE_BATCH_HEARTBEAT_MS` | 30000 | Positive integer; must be greater than 10000 and less than `MANDATE_BATCH_TIMEOUT_MS` |
| `MANDATE_BATCH_TIMEOUT_MS` | 900000 | Positive integer |
| `MANDATE_BATCH_MAX_ATTEMPTS` | 10 | Positive integer |
| `MANDATE_RETRY_INITIAL_MS` | 1000 | Positive integer; must not exceed `MANDATE_RETRY_MAX_MS` |
| `MANDATE_RETRY_MAX_MS` | 30000 | Positive integer |
| `MANDATE_SMTP_URL` | none | `smtp://host:port` or `smtps://host:port`; without it e-mail notifications fail with `channel_unconfigured` |
| `MANDATE_MAIL_FROM` | `mandate@localhost` | Sender address, up to 254 characters |
| `MANDATE_PUBLIC_URL` | `http://localhost:8400` | Origin; base of links in notifications |
| `MANDATE_AUDIT_ARCHIVE_DIR` | none | Absolute path; without it retention refuses with `archive_unavailable` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none | As for the api |
| `MANDATE_WORKER_HTTP_PORT` | 8081 | 0-65535; health (`/healthz`, `/readyz`) and metrics; blank means the default |

Set the tuning variables only with a value; an empty one is rejected.

### Compose-only variables

`.env.example` also sets variables that only Compose and the bootstrap read, such as the host ports
(`MANDATE_API_PORT`, `MANDATE_KEYCLOAK_PORT`), the database passwords, `MANDATE_CIMD_CLIENT_DOMAINS`,
`MANDATE_DCR` and `MANDATE_KEYCLOAK_SERVICE_ACCOUNTS`. They are development defaults with fake values;
replace every secret for a real installation (see [Production hardening](production.md)).
