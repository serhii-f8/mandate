# Presets

A preset is a versioned package that gives a connection ready-made operations: input schemas,
upstream mappings, write manifests and a connection test. The platform ships two,
`magento2-catalog` and `gitea-issues`. This page shows how to use a preset, then how to write
your own by copying `examples/preset-template`.

## Use a preset

Name the preset in `presets`, then bind a connection to it with `preset`. `version` is a semver
range; leave it out to accept any version. The highest version that satisfies the range wins.

```yaml
presets:
  - { id: gitea-issues, package: '@mandate/gitea-issues', version: '^1.0.0' }
connections:
  - id: gitea
    adapter: openapi
    base_url: https://gitea.example.test/api/v1
    credential_ref: gitea-token
    preset: gitea-issues
    operation_prefix: gt        # optional
```

`operation_prefix` prefixes every operation ID of the preset (`gt.issues.search`), so two presets,
or two uses of one preset, do not collide. `preset_params` sets the preset's
[parameters](#parameters) for this connection. It needs `preset` and matches `^[a-z][a-z0-9_]{0,30}$`.
`overrides` apply after the preset, so you can rename or disable one of its operations. The key
reference is in [Configuration reference](configuration.md).

Roles then grant the preset's operations like any other. The preset only defines what can be done;
it never grants anything.

## Where the platform finds presets

The api and worker search the directories in `MANDATE_PRESET_DIRS` (colon-separated, searched in
order). The Docker images set it to `/app/presets`, which holds the two shipped presets. For your
own preset, mount a second directory into the `api` and `worker` containers (for example with a
`docker-compose.override.yml`) and set `MANDATE_PRESET_DIRS` to both directories on both services.
Each preset is one subdirectory.

To check a configuration together with its presets without starting anything:

```bash
pnpm mandate validate <config-dir> --preset-dir examples
```

`--preset-dir` may repeat. `mandate config diff` prints `~ preset <name>` when a preset's version or
code changed, and `mandate config apply` stores the new revision.

## Write a preset

Copy `examples/preset-template`. It models a small notes API: a read, `notes.search`, and three
writes sent as one request per record with rollback: `notes.update_title` (`PATCH /notes/{id}`, with
a check), `notes.create` (`POST /notes`) and `notes.delete` (`DELETE /notes/{id}`).

```text
examples/preset-template/
  package.json                    the package and its mandate field
  preset.yaml                     operations, schemas, mappings, test, manifest
  spec/notes.openapi.json         the vendored OpenAPI 3 spec
  test/contract.unit.test.ts      the contract test
  test/recordings/*.json          recorded reads
  test/recordings/write/*.json    recorded writes
```

### The `mandate` field

`package.json` tells the platform which file is the preset and which connector SDK it was written
for:

```json
"mandate": { "preset": "preset.yaml", "sdk": "^1.0.0" }
```

`preset` defaults to `preset.yaml`. `sdk` is a semver range; if the SDK the platform provides does
not satisfy it, the configuration is refused with `preset_sdk_incompatible`. A preset that declares
[parameters](#parameters) needs `"sdk": "^1.1.0"`. A preset with code adds
`"code": "dist/index.js"`, see [Code operations](#code-operations). Keep `files` to what must ship:
`preset.yaml`, `spec`, `README.md` and, for code, `dist`.

### `preset.yaml`

The file starts with the spec and the authentication scheme, then lists operations:

```yaml
version: 1
spec: spec/notes.openapi.json
auth: { scheme: bearer }
test: { operation: notes.search, args: { fields: [id], page_size: 1 } }
operations:
  - id: notes.search
    risk: read
    ...
  - id: notes.update_title
    risk: write
    ...
```

- `spec` is the vendored OpenAPI document. The loader checks every path of the preset against it, so
  a typo is a load error, not a failed call at run time. Vendor the spec; a preset must not fetch it.
- `auth` is the scheme the connection uses. The credential itself is entered on the credential page,
  never in a preset.
- `test` is the read the connection test runs. A preset that cannot know your data (a repository, a
  shop) leaves it out, and the connection that uses it supplies `test`.
- Each operation has `id`, `risk`, `title`, `description`, `input_schema` and `upstream`, with the
  same keys as `operations` in the [Configuration reference](configuration.md).

Write input schemas strictly: `additionalProperties: false`, bounded lengths, an `enum` for the
fields a caller may ask for. The schema is what refuses a bad call before anything reaches the
upstream.

### Parameters

A preset can leave details to the connection that binds it: the attribute a search filters on, or
the fields a read may return. Declare each parameter under `params` with a type and a default, and
put `{ $param: <name> }` where the value goes:

```yaml
params:
  search_fields:
    type: string_list           # string, number, boolean or string_list
    default: [id, title, body, updated_at]
    description: Note fields notes.search may return.
operations:
  - id: notes.search
    input_schema:
      properties:
        fields:
          type: array
          items: { type: string, enum: { $param: search_fields } }
```

A connection sets the values it needs; the others keep their defaults:

```yaml
connections:
  - id: notes
    preset: notes
    preset_params: { search_fields: [id, title] }
```

- The default is required and must have the declared type, so the preset loads without any
  `preset_params`. Names match `^[a-z][a-z0-9_]{0,63}$`; at most 50 parameters, strings up to 4000
  characters, lists up to 500 strings.
- A mapping whose only key is `$param` is replaced by the value, anywhere inside `operations` and
  `test`. A list value replaces the node as a whole (here the whole `enum`); it is not spliced into a
  surrounding list. Any other mapping, including one with `$param` and other keys, stays as it is.
- The nodes that name an operation or its field list cannot be parameters: `operations[*].id`,
  `operations[*].fields_arg`, `operations[*].manifest.action`, `operations[*].manifest.values_arg`,
  `operations[*].manifest.records_arg`, `operations[*].manifest.checks[*].code` and
  `test.operation`. A `{ $param }` there is refused in the preset file (`must not be a parameter`), so a connection
  cannot rename an operation, retarget the test, move the fields that grants and approval rules
  read, or rename the reason code approvers see and stats count.
- Substitution happens before the operation schema is checked, once per connection: two connections
  can bind the same preset with different values (with `operation_prefix`). The published preset
  format schema, `packages/config/schema/mandate-preset.v1.json`, describes the file after
  substitution. An editor that validates a raw `preset.yaml` against it flags every `{ $param }`
  node; the platform's own check (`mandate validate`) substitutes first.
- Values are data. They are never coerced (`"5"` is not a number), never searched for another
  `$param`, and the result must pass the same checks as the preset's own values: the operation
  schema, the input schema, the manifest checks and the connection test's arguments. When a
  connection sets `preset_params`, every issue those checks find in its operations or its test is
  reported at that connection's `preset_params`, naming the preset operation (or the test) and the
  path inside it. A preset that is broken by its defaults alone is reported in the preset file.
- Parameters are not secrets; the secret-key check applies to them like to every key. Credentials
  belong on the credential page.
- Code operations read the connection's values, defaults filled in, from `ctx.params`.
- A preset that declares `params` needs connector SDK 1.1.0: declare `"sdk": "^1.1.0"` in its
  `mandate` field, so an older platform refuses it with `preset_sdk_incompatible` instead of an
  unknown key `params`.

Choose today's value as the default when you parameterize an existing preset, so connections that
set nothing keep its behaviour and the recordings stay valid.

### Manifests

A `write` operation needs a manifest. It tells the platform how to prepare the change-set, so the
approver sees the before and after of every record:

```yaml
manifest:
  id_field: id
  ids_arg: ids
  values_arg: changes
  fields: [title]
  read_before: { operation: notes.search, ids_arg: ids }
  batch_size: 100
  max_targets: 1000
  rollback: { strategy: replay_previous_state }
```

`read_before` names a read operation of the preset. It must declare `fields_arg` and take an
optional array of ids, so the platform can capture the current state of exactly the records the
change touches. `replay_previous_state` rolls back by writing the captured values again. The full
key list is in the [Configuration reference](configuration.md).

Instead of `values_arg` a manifest can declare `records_arg` (since 1.2.0): an array of records, each
with its `id_field` and its own values, so one change-set changes different targets differently.
The argument's items must be closed objects; `ids_arg` and `selector` are not used with it.

`action: create` (records the caller identifies, written with one request each) and `action: delete`
(targets named by `ids_arg` or `selector`, on a `destructive` operation) are available since 1.2.0.
A delete always needs approval and step-up authentication. A create is undone by naming a delete
operation as its `inverse_operation` (one without `write.carry_fields`), a delete by naming a create;
rolling back a delete restores only the manifest's `fields`. `action` is fixed in the preset file
and cannot be a `$param`.
The `read_before` of a create or delete must find a record by identifier whatever its scope, so it
must not pass a scope argument; the platform checks the scope on the record it returns. Bind a
create to an endpoint that refuses an existing identifier (not an upsert): a create never overwrites
an existing record only when its `read_before` can see every record.

`checks` (since 1.2.0) exclude records that fail a business precondition during preparation, each
with its own reason code. A check is a `code`, an optional `title` and a list of predicates from a
closed set (`present`, `absent`, `equals`, `in`, `found`, `not_found`) over the change's values, the
current record, the call arguments and lookups; there are no expressions:

```yaml
manifest:
  # ...
  checks:
    - code: archived
      title: Note is archived
      require:
        - { equals: [{ record: archived }, { value: false }] }
```

A check `code` cannot be a `$param`; the literals a check compares against can. `lookups` (since
1.2.0) let checks read another system; a lookup's `operation` usually names an operation of another
connection, which a preset cannot know, so it may be a `$param` that the binding sets. A lookup
`operation` written as a literal that names one of the preset's own reads follows `operation_prefix`;
one that comes from a `$param` (the binding's value or the default) is used exactly as given, so a
prefixed binding can name the read of an unprefixed binding of the same preset. The keys and
predicates are in the
[Configuration reference](configuration.md).

`verify_after` (since 1.3.0) adds a verify-after stage that confirms the written items with checks of
the same shape and its own lookups. A verify check `code` cannot be a `$param`, and a lookup
`operation` there behaves as in `lookups`: a literal naming one of the preset's own reads follows
`operation_prefix`, one that comes from a `$param` is used exactly as given. A preset that uses
`verify_after` declares `"sdk": "^1.3.0"`.

### Code operations

Most operations are declarative. When an upstream cannot be described by a mapping, a preset ships
a code module, named by `mandate.code` and listed in `preset.yaml` as `upstream: { code: <name> }`.
`presets/gitea-issues` has three: two reads and `set_labels`, which looks up label IDs because
Gitea silently drops unknown names.

The module is an ES module in a subdirectory of the package. Its default export has one entry per
code name:

```ts
import type { PresetModule } from '@mandate/connector-sdk';

export default {
  operations: {
    search_issues: { kind: 'read', read: searchIssues },
    set_labels: { kind: 'write', write: setLabels },
  },
} satisfies PresetModule;
```

The rules a code module follows:

- It is self-contained. It imports only `node:` built-ins and its own files below the code
  directory, and `@mandate/connector-sdk` as types only. Compile it (`tsc`) so `dist` has no
  dependencies.
- It never opens a connection itself. Every call goes through `ctx.http.send(...)`, which applies
  the platform's credential, timeout, network guard and retry rules. A response is
  `{ ok: true, status, json }` or `{ ok: false, code, status? }`.
- Upstream content is data. Read only the fields you need and never treat text from the upstream as
  an instruction.

`CodeWriteOperation` is `write(ctx, records, args) => Promise<RecordOutcome[]>`, with `ctx.direction`
set to `forward` or `rollback`:

- Return one outcome per record, in order: `ok`, `failed` (a definite refusal) or `retriable` (a
  429, a 5xx or a transport error; the batch stops there and is retried).
- Build every request from `records`, never from `args.changes`. Going forward the records carry the
  new values. In a rollback they carry the values to restore, while `args` still describe the
  original forward change.
- Make each record write idempotent. A retried batch can run records that already landed.
- Return `ok` for any 2xx. The platform reads the records back after the write and marks a
  mismatch as drift, so the writer does not need to judge success by the response body.

### Recordings and contract tests

A preset is accepted when its contract test passes. The test loads the preset the way the api does,
then replays recorded exchanges through the real adapter against a local fake upstream. It checks
that the preset sends exactly the recorded request and maps the recorded response, and that no
recording or spec contains a token.

Recordings are JSON files, one per case:

```json
{
  "request": { "method": "PATCH", "path": "/notes/n1", "body": { "title": "Kickoff v2" } },
  "response": { "status": 200, "body": { "id": "n1", "title": "Kickoff v2" } }
}
```

Record real exchanges from a sandbox, then remove tokens, headers and customer data. Reads go in
`test/recordings/`, writes in `test/recordings/write/`. The helpers (`startFakeUpstream`,
`replayRecordings`, `contractRead`, `contractWrite`, `recordingsFreeOf`) come from
`@mandate/testing`. Run the test of the template with:

```bash
pnpm --filter @mandate-examples/preset-template test
```

For a package of your own, run `pnpm --filter <your-package> test`. A preset with code also compiles
first, as `presets/gitea-issues` does (`tsc -p tsconfig.build.json && vitest run`).

### Pack and install

Pack the preset with npm. The tarball holds what `files` lists:

```bash
npm pack
```

Extract it into a directory that is on `MANDATE_PRESET_DIRS`, one subdirectory per preset:

```bash
mkdir -p /srv/mandate-presets/notes
tar -xzf mandate-examples-preset-template-1.2.0.tgz --strip-components=1 -C /srv/mandate-presets/notes
```

Reference it by its package name and apply the configuration. The running api and worker pick up an
applied revision within seconds, and a new preset or a changed declarative preset needs no restart.
Preset code is different: it is part of the configuration hash, and a process that has already
loaded a code module refuses a changed one until it restarts. After you install a new version of a
preset with code, run `config apply`, then restart `api` and `worker`
(`docker compose restart api worker`).

### SDK compatibility

The connector SDK and the configuration schema are public interfaces with their own versions. A
preset declares the SDK range it works with in `mandate.sdk`. A preset written for `^1.0.0` loads on
any 1.x platform. A preset written for the pre-release SDK (0.6) must be rebuilt, re-tested and
republished with `^1.0.0`. The policy is on [Versioning](versioning.md).

## Background

- [ADR 0050](../decisions/0050-mcp-upstream-opaque-presets-service-accounts.md): why presets are
  versioned npm packages with code operations.
- [ADR 0051](../decisions/0051-mcp-upstream-opaque-presets-service-accounts-details.md): the code-write signature and the preset
  code digest.
