# @aiops/gitea-issues

Gitea issues preset 0.1.0 (CONN-8, OPS-5, OPS-6; design `docs/design/phase-9-mcp-upstream-gitea.md`).
The second preset, proving the same connector interfaces carry a different upstream: code reads, a
code write that verifies label names, declarative writes and a vendored filtered spec.

## Use

```yaml
presets:
  - { id: gitea-issues, package: '@aiops/gitea-issues', version: '^0.1.0' }
connections:
  - id: gitea
    adapter: openapi
    base_url: https://gitea.example.test/api/v1    # the Gitea root plus /api/v1
    credential_ref: gitea-token                     # entered on the credential page
    preset: gitea-issues
    # The preset has no default test: it cannot know a repository. Code reads need `fields`.
    test: { operation: issues.search, args: { owner: acme, repo: website, fields: [number], limit: 1 } }
```

**Credential.** Auth is `bearer`: on the credential page paste the bare access token (40 hex
characters), not `token <t>`; the adapter sends `Authorization: Bearer <t>`, which Gitea accepts.
Scope `write:issue` is enough for every operation, on public and private repositories.

The api finds the package through `AIOPS_PRESET_DIRS`; `aiops validate <dir> --preset-dir presets`
checks it from the repository.

## Operations

| Operation | Risk | Arguments | Upstream |
| --- | --- | --- | --- |
| `issues.search` | read | `owner`, `repo`, `fields`, `state` (`open`/`closed`/`all`, default `open`), `labels` (≤10 names, any of them), `q`, `page` (default 1), `limit` (1-50, default 30) | code `search_issues`: `GET /repos/{owner}/{repo}/issues?type=issues` |
| `issues.get_many` | read | `owner`, `repo`, `numbers` (1-50 decimal strings), `fields` | code `get_issues`: one `GET /repos/{owner}/{repo}/issues/{n}` per number |
| `issues.update_fields` | write | `owner`, `repo`, `numbers` (1-500) or `with_labels` (exactly one), `changes` (`title`, `state`) | `PATCH /repos/{owner}/{repo}/issues/{number}`, body = the record without `number` |
| `issues.set_labels` | write | `owner`, `repo`, `numbers` or `with_labels` (exactly one), `changes.labels` (0-20 names) | code `set_labels`: label list, then `PUT /repos/{owner}/{repo}/issues/{number}/labels` with ids |
| `issues.comment` | write_opaque | `owner`, `repo`, `number` (integer), `comment.body` | `POST /repos/{owner}/{repo}/issues/{number}/comments`, sent once |

`fields` is an enum of `number, title, state, labels, owner, repo, updated_at`. Both reads return
the same normalised issue: label **names** sorted by code point, `owner` and `repo` taken from
the issue's own repository. Pull requests are never returned; an unknown number or a pull request
in `numbers` is skipped (core reports it `not_found`). Issue numbers are decimal strings in
`numbers`, because core passes target IDs as strings.

Label names (`labels`, `with_labels`, `changes.labels`) may not contain commas (the search sends
them comma-joined) or control characters; the input schemas refuse them.

### Scope

Grant by `owner` and `repo`, e.g. `scope: { owner: [acme], repo: [website] }`, on all five
operations. Both writes list them in `scope_args`, and core re-checks every record against the
`owner` and `repo` the reads return. The match is exact and **case-sensitive**: a call with
`Acme` against a grant of `acme` is refused (fails closed), although Gitea itself would accept it.

### Write manifests

Both writes read current state with `issues.get_many` (batches of 50), cap a change-set at 500
targets and roll back with `replay_previous_state`.

- **Selector.** `with_labels` selects the **open** issues having **any** of the names, through
  `issues.search` with `state: open` fixed, 50 per page (Gitea's `max_response_items`). Exactly
  one of `numbers` and `with_labels` is enforced by `minProperties`/`maxProperties` 4 (no root
  combinator, ADR 0026).
- `issues.set_labels` carries `owner` and `repo` in every record (`write.carry_fields`): the code
  writer learns the repository only from them.

### `issues.set_labels`

Gitea's `PUT …/labels` silently drops unknown names and ids, so the writer resolves names itself:

- It lists the repository's labels and maps each name to its id: exact, case-sensitive, and
  repository labels only (an organisation label or `Bug` for `bug` is unknown). A record with an
  unknown name is `failed` and nothing is sent for it.
- The Gitea server's `max_response_items` must be at least 50; otherwise label names past the
  first page read as unknown and the record fails.
- A repository with more than 1000 labels makes `set_labels` fail.
- If a repository has two labels with the same name, the first id is attached.
- A PUT that Gitea answers with 2xx is reported `ok`; core's verify read then decides, so a
  partial result ends `drift`. A 429, a 5xx or a transport error is `retriable` and stops sending
  for the rest of the batch.
- **Give labels sorted.** Core compares the label list by order: `[triage, bug]` on an issue
  with `[bug, triage]` shows as a change, writes, and the item ends `drift` (the verify read
  answers the sorted list). Sorted labels avoid this.

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
