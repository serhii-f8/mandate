# Preset template

A working, contract-tested preset to copy when you write your own (CONN-8, NFR-17). It models a
small notes API: one read, `notes.search`, and one write, `notes.update_title`, which is a
manifest write sent as one `PATCH /notes/{id}` per record with `replay_previous_state` rollback.

| File | Purpose |
| --- | --- |
| `package.json` | the package; the `mandate` field names the preset file and the connector SDK range |
| `preset.yaml` | operations, input schemas, upstream mappings, the connection test and the manifest |
| `spec/notes.openapi.json` | the vendored OpenAPI 3 spec the preset's paths are checked against |
| `test/contract.unit.test.ts` | loads the preset like the api does and replays the recordings |
| `test/recordings/` | hand-written request/response pairs; `write/` holds the write exchange |

## Copy and adapt

1. Copy the directory, rename the package in `package.json` and the preset id in the test.
2. Replace the spec with your upstream's OpenAPI document and the operations in `preset.yaml`.
3. Keep the read that serves as `read_before` taking an optional array of ids (`ids_arg`): the
   manifest needs it to capture the before state.
4. Record real exchanges from a sandbox, strip tokens and customer data, and update the cases.
5. Run `pnpm --filter <your-package> test`.

## Try it

```bash
pnpm --filter @mandate-examples/preset-template test
pnpm mandate validate <config-dir> --preset-dir examples
```

The configuration binds the preset to a connection, for example
`presets: [{ id: notes, package: '@mandate-examples/preset-template', version: '1.0.0' }]` and a
connection with `preset: notes`, `adapter: openapi` and a `base_url`.
