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
  - { id: gitea-issues, package: '@aiops/gitea-issues', version: '^1.0.0' }
connections:
  - id: gitea
    adapter: openapi
    base_url: https://gitea.example.test/api/v1
    credential_ref: gitea-token
    preset: gitea-issues
    operation_prefix: gt        # optional
```

`operation_prefix` prefixes every operation ID of the preset (`gt.issues.search`), so two presets,
or two uses of one preset, do not collide. It needs `preset` and matches `^[a-z][a-z0-9_]{0,30}$`.
`overrides` apply after the preset, so you can rename or disable one of its operations. The key
reference is in [Configuration reference](configuration.md).

Roles then grant the preset's operations like any other. The preset only defines what can be done;
it never grants anything.

## Where the platform finds presets

The api and worker search the directories in `AIOPS_PRESET_DIRS` (colon-separated, searched in
order). The Docker images set it to `/app/presets`, which holds the two shipped presets. For your
own preset, mount a second directory into the `api` and `worker` containers (for example with a
`docker-compose.override.yml`) and set `AIOPS_PRESET_DIRS` to both directories on both services.
Each preset is one subdirectory.

To check a configuration together with its presets without starting anything:

```bash
pnpm aiops validate <config-dir> --preset-dir examples
```

`--preset-dir` may repeat. `aiops config diff` prints `~ preset <name>` when a preset's version or
code changed, and `aiops config apply` stores the new revision.

## Write a preset

Copy `examples/preset-template`. It models a small notes API: a read, `notes.search`, and a write,
`notes.update_title`, sent as one `PATCH /notes/{id}` per record with rollback.

```text
examples/preset-template/
  package.json                    the package and its aiops field
  preset.yaml                     operations, schemas, mappings, test, manifest
  spec/notes.openapi.json         the vendored OpenAPI 3 spec
  test/contract.unit.test.ts      the contract test
  test/recordings/*.json          recorded reads
  test/recordings/write/*.json    recorded writes
```

### The `aiops` field

`package.json` tells the platform which file is the preset and which connector SDK it was written
for:

```json
"aiops": { "preset": "preset.yaml", "sdk": "^1.0.0" }
```

`preset` defaults to `preset.yaml`. `sdk` is a semver range; if the SDK the platform provides does
not satisfy it, the configuration is refused with `preset_sdk_incompatible`. A preset with code adds
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

### Code operations

Most operations are declarative. When an upstream cannot be described by a mapping, a preset ships
a code module, named by `aiops.code` and listed in `preset.yaml` as `upstream: { code: <name> }`.
`presets/gitea-issues` has three: two reads and `set_labels`, which looks up label IDs because
Gitea silently drops unknown names.

The module is an ES module in a subdirectory of the package. Its default export has one entry per
code name:

```ts
import type { PresetModule } from '@aiops/connector-sdk';

export default {
  operations: {
    search_issues: { kind: 'read', read: searchIssues },
    set_labels: { kind: 'write', write: setLabels },
  },
} satisfies PresetModule;
```

The rules a code module follows:

- It is self-contained. It imports only `node:` built-ins and its own files below the code
  directory, and `@aiops/connector-sdk` as types only. Compile it (`tsc`) so `dist` has no
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
`@aiops/testing`. Run the test of the template with:

```bash
pnpm --filter @aiops-examples/preset-template test
```

For a package of your own, run `pnpm --filter <your-package> test`. A preset with code also compiles
first, as `presets/gitea-issues` does (`tsc -p tsconfig.build.json && vitest run`).

### Pack and install

Pack the preset with npm. The tarball holds what `files` lists:

```bash
npm pack
```

Extract it into a directory that is on `AIOPS_PRESET_DIRS`, one subdirectory per preset:

```bash
mkdir -p /srv/aiops-presets/notes
tar -xzf aiops-examples-preset-template-1.0.0.tgz --strip-components=1 -C /srv/aiops-presets/notes
```

Reference it by its package name, apply the configuration, and restart nothing: the running api and
worker pick up an applied revision within seconds. Because the preset code is part of the
configuration hash, a changed preset needs `config apply` again. A process that has already loaded
a code module refuses a changed one until it restarts.

### SDK compatibility

The connector SDK and the configuration schema are public interfaces with their own versions. A
preset declares the SDK range it works with in `aiops.sdk`. A preset written for `^1.0.0` loads on
any 1.x platform. A preset written for the pre-release SDK (0.6) must be rebuilt, re-tested and
republished with `^1.0.0`. The policy is on [Versioning](versioning.md).

## Background

- [ADR 0050](../decisions/0050-mcp-upstream-opaque-presets-service-accounts.md): why presets are
  versioned npm packages with code operations.
- [ADR 0051](../decisions/0051-phase-9-plan-rulings.md): the code-write signature and the preset
  code digest.
