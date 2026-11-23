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
- `changesets`, `audit`, `rate_limits` and `files` may be set in one file only.
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
| `files` | object | see below | Staging of files that operations take as arguments (since 1.4.0) |

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
| `auth.scheme` | `bearer`, `api_key`, `basic`, `oauth_client_credentials`, `oauth_password`, `oauth1` | none | `oauth1` since 1.1.0: OAuth 1.0a request signing (RFC 5849), refused on `mcp` connections; the body is not signed, so a form-encoded body is not supported. Secret: `consumer_key`, `consumer_secret`, `token`, `token_secret`. `oauth_password` since 1.1.0: the OAuth password grant, for upstreams that offer nothing else (OAuth 2.1 removes the grant). Secret: `client_id`, `client_secret`, `username`, `password` |
| `auth.header` | header name | required for `api_key` | |
| `auth.token_url` | http(s) URL | required for `oauth_client_credentials` and `oauth_password` | Its host joins the connection's allowed hosts |
| `auth.scopes` | list of strings | `[]` | `oauth_client_credentials` and `oauth_password` |
| `auth.signature_method` | `HMAC-SHA256`, `HMAC-SHA1` | `HMAC-SHA256` | `oauth1` only; since 1.1.0 |
| `auth.client_auth` | `basic`, `body` | `basic` | `oauth_password` only; since 1.1.0. `basic`: client id and secret in a Basic header. `body`: as form fields, for token endpoints that do not accept the header |
| `preset` | id | none | Names an entry of `presets` |
| `operation_prefix` | string | none | `^[a-z][a-z0-9_]{0,30}$`; requires `preset` |
| `preset_params` | map of name to value | none | Since 1.1.0; requires `preset`. Values of the preset's [parameters](presets.md#parameters): a string (up to 4000 characters), a number, a boolean or a list of up to 500 strings, of the declared type (never coerced); at most 50 entries. Unset parameters take the preset's default |
| `timeout_ms` | integer | 10000 | 1-120000 |
| `retry.max_attempts` | integer | 3 | 1-10 |
| `retry.initial_backoff_ms` | integer | 200 | 0-60000 |
| `max_concurrency` | integer | 4 | 1-1000 |
| `rate.requests_per_second` | number | none (unpaced) | 0.01-1000; since 1.1.0. Requests of the connection start at least `1000 / value` ms apart, retries included; per process. On an `mcp` connection the unit is one attempt of a tool operation (list, call), which can be several HTTP requests (initialize, notification, call, session `DELETE`) |
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
| `fields_arg` | string | none | 1-128 characters; the argument that selects returned fields; for a write it defaults to, and must equal, `manifest.values_arg` or `manifest.records_arg` |
| `manifest` | object | none | Required for `write`; allowed on `destructive`; not allowed on `read` or `write_opaque` |
| `files` | list | none | Since 1.4.0. 1-5 file arguments; only on `write_opaque`, or `destructive` without a manifest, with an HTTP binding; see below |

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
| `action` | `update`, `create` or `delete` | `update` | Since 1.2.0. What the call does to its targets; a fixed node in presets. `create` needs `records_arg`, no `write.carry_fields`, and every `scope_args` field in `fields`. `delete` needs `ids_arg` or `selector`, neither `values_arg` nor `records_arg`, and `risk: destructive`, so it always needs approval and step-up authentication. `replay_previous_state` is not available for either. The `read_before` of a create or delete must find a record by identifier whatever its scope, so its `args` must not pass a scope argument (the platform checks the scope on the returned record); a create binding should refuse an existing identifier upstream. "Never overwritten" holds only under such a read |
| `id_field` | string | required | |
| `ids_arg` | string | none | With `values_arg`: give `ids_arg`, `selector` or both |
| `values_arg` | string | one of two | Since 1.2.0 optional: declare exactly one of `values_arg` and `records_arg`. A required object property of `input_schema` with `additionalProperties: false` and no `patternProperties`; one set of values for every target |
| `records_arg` | string | one of two | Since 1.2.0. A required array property of `input_schema` (no `prefixItems`) whose items are closed objects (`additionalProperties: false`, no `patternProperties`) with `id_field` (required, `string` or `integer`; `string` for a create, whose identifier is sent as the target ID string and is not stored with its JSON type) and properties from `fields`; each record carries its own values. `id_field` must not be one of `fields`. `ids_arg` and `selector` are not allowed with it. `fields_arg` defaults to it |
| `fields` | list | required | At least 1 |
| `required_fields` | list | `[]` | For a create each must be one of `fields` (they are checked against the new record) |
| `sensitive_fields` | list | `[]` | Each must be in `fields`; the audit trail redacts their values |
| `scope_args` | map | `{}` | Scope name to argument name |
| `read_before` | object | required | `operation`, `ids_arg`, `args`. For an update `args` passes every scope argument as `{ arg: <name> }`; for a create or delete it must pass none, so the read finds a record by identifier whatever its scope |
| `selector` | object | none | `operation`, `args`, `page_arg`, `page_size_arg`, `page_size` (1-1000, default 100) |
| `write.carry_fields` | list | none | At least 1 |
| `batch_size` | integer | 100 | 1-1000 |
| `max_targets` | integer | 10000 | 1-100000 |
| `rollback` | object | required | `strategy: replay_previous_state`, `none`, or `inverse_operation` with `operation`. The inverse of a `create` is a `delete` operation of the same connection and `id_field`; the inverse of a `delete` is a `create` whose `fields` cover this one's. The inverse delete of a create declares no `write.carry_fields`: the rollback sends the identifier only. Rolling back a delete restores only the manifest's `fields`. The inverse of an `update` must be an `update` operation |

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

`manifest.checks` (since 1.2.0, optional, at most 20) are preparation checks, evaluated in order on
every item that passed the built-in exclusions (`not_found`, `out_of_scope`, `missing_data`,
`no_change`, `already_exists`). The first check with a predicate that does not hold excludes the item
with its `code`, keeping its `before` and `after`. Checks run at preparation only.

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| `code` | string | required | `^[a-z][a-z0-9_]{0,62}$`, unique within the manifest, not a built-in reason (`not_found`, `out_of_scope`, `missing_data`, `no_change`, `already_exists`, `requester`) and not a reserved name (a member of JavaScript's `Object.prototype`, of which only `constructor` fits the pattern). The reason approvers see and stats count; a fixed node in presets |
| `title` | string | none | 1-120 characters of plain text, shown beside the code on the approval page and in the widget |
| `require` | list | required | 1-10 predicates, all of which must hold |

Each predicate is an object with exactly one predicate key. A reference is `{ after: f }` or
`{ before: f }` (a field of `fields`; the side is `null` for a create's `before` and a delete's
`after`), `{ record: f }` (the current upstream record, which a create does not have; the field is
added to the `read_before` read and must be one it can return), `{ arg: name }` (a property of
`input_schema`) or `{ lookup: name, field: f }`. On an update, `{ before: f }` and `{ after: f }` see
only the fields this item touches; for any other field of the record use `{ record: f }`. A reference
that can never resolve for the action is refused at load (`is not available for action <action>`):
`{ before: f }` and `{ record: f }` on a create, `{ after: f }` on a delete; the same holds for a
lookup `key`.

| Predicate | Holds when |
| --- | --- |
| `{ present: <ref> }` | The value is not `null`, not missing and not `''` |
| `{ absent: <ref> }` | `present` does not hold |
| `{ equals: [<ref>, <ref> \| { value: <literal> }] }` | Both sides are equal as canonical JSON; `null` and missing are equal. A value that cannot be compared makes it false |
| `{ in: <ref>, values: [<literal>, ...] }` | The value is strictly one of 1-100 literals (string, number or boolean; no type coercion) |
| `{ found: <lookup> }` / `{ not_found: <lookup> }` | The lookup has, or has no, result for the item |

A lookup reference, `found` and `not_found` must name a declared lookup, and `{ lookup: name,
field: f }` one of that lookup's `fields`.

```yaml
    manifest:
      # ...
      checks:
        - code: locked
          title: Product is locked for editing
          require:
            - { equals: [{ record: locked }, { value: false }] }
        - code: inactive
          require:
            - { in: { record: status }, values: [1] }
```

`manifest.lookups` (since 1.2.0, optional, at most 5) read another system during preparation, so
that checks can test what it holds. Each lookup is a read of an enabled `read` operation with
`fields_arg` on any connection, keyed per item; the checks read it with `{ found: name }`,
`{ not_found: name }` and `{ lookup: name, field: f }`. Lookup values are used by the checks only:
they are never stored, shown, audited or returned. The write's policy decision covers its lookups, so
a requester needs no grant on the lookup operation, and learns one exclusion code per target. A
lookup read uses its own connection's egress rules, pacing and credential.

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| name (map key) | string | required | `^[a-z][a-z0-9_]{0,62}$`, not a reserved name; every lookup must be used by a check |
| `operation` | operation ID | required | An enabled `read` operation with `fields_arg`, on any connection. May be a `$param` in a preset |
| `ids_arg` | string | required | An array property of the operation, with string items or items without a type; its `maxItems`, if set, must be at least `batch_size` |
| `key_field` | string | required | The result field matched against the key; a field the operation can return |
| `key` | object | required | `{ target: true }` (the target ID), `{ after: f }` or `{ before: f }` (one of `fields`, from the item's side) or `{ record: f }` (a field of the current record, added to the `read_before` read and one it can return) |
| `fields` | list | required | 1-50 fields the operation can return; the checks may read these |
| `args` | map | `{}` | Templates as in `read_before`: each key an argument of the operation, each `{ arg }` a property of `input_schema` |

During preparation each lookup reads, per read chunk, the distinct keys of the items still pending
after the built-in exclusions, in chunks of `batch_size`, and indexes the results by `key_field` (the
first record with a key wins). A key that is not a string or a number, or that the read does not
return, makes the lookup "not found" for that item. A failed lookup read fails the preparation with
`lookup_failed` and the upstream status. A truncated one, or a page with fewer records than the
total the upstream reports (for example a default page size), fails it with `incomplete_read`, as a
truncated `read_before` read does (and, for a create or delete, a `read_before` page shorter than its
total or holding a record without an identifier). A lookup that could not be read completely is never
"not found".

```yaml
    manifest:
      # ...
      lookups:
        erp:
          operation: erp.get_parts
          ids_arg: codes
          key_field: code
          key: { target: true }
          fields: [state]
      checks:
        - code: not_in_erp
          title: Part is not in the ERP
          require:
            - { found: erp }
            - { in: { lookup: erp, field: state }, values: [released] }
```

`manifest.verify_after` (since 1.3.0, optional) confirms the written items after the last batch: it
re-checks each item that was written until its checks hold or the time runs out. It is allowed on a
`write` or `destructive` operation with a manifest, not on an opaque one. The stage runs only when the
batch loop ended with nothing left to do.

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| `after_seconds` | integer | `0` | 0-86400. Wait before the first look, from the end of the last batch |
| `every_seconds` | integer | `30` | 10-3600. Wait between looks |
| `timeout_seconds` | integer | `600` | 10-604800, not below `after_seconds`. From the end of the last batch; items still pending then end `unconfirmed`. At most 1000 looks: `(timeout_seconds - after_seconds) / every_seconds` must not exceed 1000 |
| `lookups` | map | none | At most 5, the shape of `manifest.lookups` above, with the same rules. Its own namespace: a verify check reads only these, never the preparation lookups. Every lookup must be used by a verify check |
| `checks` | list | required | 1-20 checks of the shape of `manifest.checks`, each with at most 10 predicates, evaluated in order; all must hold for an item to be confirmed |

A verify check `code` follows the rule of a preparation check and is also not one of the fixed
verification codes (`verify_read_failed`, `verify_timeout`, `verify_cancelled`) nor the code of a
preparation check of the same operation, so one code has one meaning per operation. The references
are those of a preparation check, except that `{ record: f }` is the record as it is read at the
look, so it is available for a create and a delete too (a deleted record is simply absent), and the
`after` and `before` sides are the stored item, so `{ before: f }` is refused on a create and
`{ after: f }` on a delete. The same holds for a lookup `key`.

```yaml
    manifest:
      # ...
      verify_after:
        after_seconds: 60
        every_seconds: 30
        timeout_seconds: 900
        checks:
          - code: not_applied
            title: Upstream still shows the old value
            require:
              - { equals: [{ record: name }, { after: name }] }
```

The `read_before` operation must be an enabled read operation that declares `fields_arg`; that
argument must be a required property of its `input_schema` and equal `upstream.response.fields_from_arg`.
A grant
`scope` key must be an argument of the operation and, for a write with a manifest, a key of
`manifest.scope_args`.

`files` (since 1.4.0, optional) declares which arguments of an opaque HTTP operation hold a staged
file. The caller passes the ID of an uploaded file there; the change-set carries the file's descriptor
and content hash instead. The operation needs an explicit `input_schema`: every parent along `at` is
`type: object` with the next name in `required`, and the leaf is exactly `{ type: string, format: uuid }`
(besides `title` and `description`), so a file argument is always present.

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| `at` | string | required | Where the file sits in the arguments: `/a/b/c`, 1-8 property names each matching `^[A-Za-z_][A-Za-z0-9_]{0,63}$`; no array index, no `~` escape. Paths are distinct and none is a prefix of another |
| `send` | `base64` or `multipart` | required | How the file is sent upstream: `base64` puts the encoded bytes in the argument; `multipart` sends the request as `multipart/form-data` (since 1.4.0). The value is the same for every file of the operation |
| `media_types` | list of strings | required | 1-20 declared types the caller may send, lower case, `type/subtype` |
| `max_bytes` | integer | `files.max_bytes` | 1 to `files.max_bytes` |
| `part` | string | the argument name | `^[A-Za-z0-9_.-]{1,64}$`; allowed only with `send: multipart`; unique within the operation, defaults included |

```yaml
files:
  - at: /entry/content/base64_encoded_data
    send: base64
    media_types: [image/png, image/jpeg]
    max_bytes: 5000000
```

A complete operation, with the explicit schema the loader requires:

```yaml
operations:
  - id: media.upload
    connection: shop
    risk: write_opaque
    description: Upload a product image.
    upstream: { method: POST, path: /V1/products/media }
    input_schema:
      type: object
      properties:
        sku: { type: string }
        entry:
          type: object
          properties:
            content:
              type: object
              properties:
                base64_encoded_data: { type: string, format: uuid }
              required: [base64_encoded_data]
          required: [content]
      required: [sku, entry]
      additionalProperties: false
    files:
      - at: /entry/content/base64_encoded_data
        send: base64
        media_types: [image/png, image/jpeg]
        max_bytes: 5000000
```

The caller passes the staged file's ID at `entry.content.base64_encoded_data`; the worker puts the
file's bytes, base64 encoded, in that place of the request body. See
[Staged files](usage.md#administer) for the upload and the approver's view.

With `send: multipart` the request body is `multipart/form-data`: the text fields are the entries of
the operation's `upstream.body` template (it must render an object of strings, numbers and booleans;
otherwise nothing is sent), and each file is one part named `part`, carrying the staged file's name and
declared type and its exact bytes. A multipart `at` is a top-level argument (one segment); the file
properties are not part of the text fields. The operation cannot also declare `upstream.bulk`.

```yaml
files:
  - { at: /front, send: multipart, media_types: [image/png], part: front_image }
  - { at: /back, send: multipart, media_types: [image/png] }   # part: back
```

A grant `scope` must not name an argument that is a one-segment file path: it holds a file ID, which
no scope value could match.

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
| `approval.field_rules` | list | none | 1-20 entries, first match wins; each has `fields` (at least 1) and the keys above except `field_rules`. Needs `fields_arg` on the write operations the role's rule covers; where an operation's fields argument is closed (`additionalProperties: false` or `items.enum`), each name must be one of its fields. A field rule starts from its own defaults: `allow_widget` and `step_up_max_age_seconds` are not inherited from the rule it replaces |
| `grants[].approval` | map | none | Same keys as `approval`; replaces the role's rule for calls this grant allows, starting from its own defaults (`allow_widget` and `step_up_max_age_seconds` are not inherited from the role's rule) |
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

### `files`

Settings of staged files (OPS-8, since 1.4.0); at most one document may set them. Absent keys take the
defaults.

| Key | Type | Default | Bounds / notes |
| --- | --- | --- | --- |
| `max_bytes` | integer | 10485760 | 1-26214400 (25 MiB). The most an uploaded file and any `files[].max_bytes` may be |
| `staged_ttl_hours` | integer | 24 | 1-720. An unreferenced file's content is removed after this |
| `keep_days` | integer | 7 | 0-365. Content is kept this long after the last change-set that uses it ended |
| `per_user_count` | integer | 50 | 1-1000. Files with content per uploader |
| `per_user_bytes` | integer | 262144000 | 1-10737418240. Bytes with content per uploader |

```yaml
files:
  max_bytes: 5242880
  keep_days: 3
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
