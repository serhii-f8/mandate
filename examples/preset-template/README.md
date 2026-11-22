# Preset template

A working, contract-tested preset to copy when you write your own (CONN-8, NFR-17). It models a
small notes API: one read, `notes.search`, and three manifest writes sent as one request per
record: `notes.update_title` (`PATCH /notes/{id}`, `replay_previous_state` rollback),
`notes.create` and `notes.delete`.

| File | Purpose |
| --- | --- |
| `package.json` | the package; the `mandate` field names the preset file and the connector SDK range |
| `preset.yaml` | operations, input schemas, upstream mappings, the connection test and the manifest |
| `spec/notes.openapi.json` | the vendored OpenAPI 3 spec the preset's paths are checked against |
| `test/contract.unit.test.ts` | loads the preset like the api does and replays the recordings |
| `test/recordings/` | hand-written request/response pairs; `write/` holds the write exchange |

## What each operation shows

- **`notes.update_title`** changes the same field on many notes (`values_arg`). Its `empty_title`
  check (since 1.2.0) leaves a note that has no title yet out of the change-set during preparation:
  the item is excluded with that reason code and never written.
- **`notes.create`** takes `notes: [{ id, title, body? }]` (`records_arg`): every record carries its
  own values. A note whose id already exists is excluded with `already_exists`; one that appears
  between approval and execution is skipped as drift and not sent. That holds because
  `notes.search` finds a note by id whatever else it has: the `read_before` of a create or delete
  must not filter by scope (the template has none), and `POST /notes` should refuse an existing id.
  Its rollback is `notes.delete`.
- **`notes.delete`** takes `ids` and is `destructive`: it always needs approval with step-up
  authentication. The change-set keeps each note's `title` and `body`, so its rollback,
  `notes.create`, can put them back. The two operations name each other as the inverse; the loader
  checks that they match.

## Copy and adapt

1. Copy the directory, rename the package in `package.json` and the preset id in the test.
2. Replace the spec with your upstream's OpenAPI document and the operations in `preset.yaml`.
3. Keep the read that serves as `read_before` taking an optional array of ids (`ids_arg`): the
   manifest needs it to capture the before state.
4. Record real exchanges from a sandbox, strip tokens and customer data, and update the cases.
5. Run `pnpm --filter <your-package> test`. A per-record `DELETE` carries the record minus its path
   fields, so the recorded `DELETE /notes/n1` request has body `{}`.

## Try it

```bash
pnpm --filter @mandate-examples/preset-template test
pnpm mandate validate <config-dir> --preset-dir examples
```

The configuration binds the preset to a connection, for example
`presets: [{ id: notes, package: '@mandate-examples/preset-template', version: '1.2.0' }]` and a
connection with `preset: notes`, `adapter: openapi` and a `base_url`. The parameter `search_fields` (the fields
`notes.search` may return) can be narrowed with `preset_params: { search_fields: [id, title] }`; see
[Parameters](../../docs/guide/presets.md#parameters).
