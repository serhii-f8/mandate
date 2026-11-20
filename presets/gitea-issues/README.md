# @aiops/gitea-issues

Gitea issues preset 0.1.0 (CONN-8, OPS-5, OPS-6; design `docs/design/phase-9-mcp-upstream-gitea.md`).
The second preset, proving the same connector interfaces carry a different upstream: code reads, a
code write that verifies label names, declarative writes and a vendored filtered spec.

This package is a skeleton: the operations, `preset.yaml` and the code come in later tasks.

## Vendored spec and recordings

`spec/gitea.swagger.json` is `GET /swagger.v1.json` of Gitea 28.3.0 filtered to the five endpoints
of the preset. `test/recordings/*.json` (reads) and `test/recordings/write/*.json` (writes) are
`{ "exchanges": [...] }` files of the `RecordedExchange` type of `@aiops/testing`: method, path
relative to `/api/v1`, string query values, body, and the response. No header is stored.

Re-record against the sandbox (`bash deploy/sandbox/gitea/up.sh`, seeded):

```sh
GITEA_SANDBOX_URL=http://127.0.0.1:4391 GITEA_SANDBOX_TOKEN="$(bash deploy/sandbox/gitea/token.sh)" \
  pnpm --filter @aiops/gitea-issues record
```
