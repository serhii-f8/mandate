# ADR 0015: Configuration format, loader and `validate`

- Status: Accepted
- Date: 2026-11-16

## Context

CFG-1 loads roles, connections, operations, presets, limits and notification targets
from a directory of YAML files; CFG-2 requires file, path and reason per error and
all-or-nothing loading with the previous configuration kept; CFG-5 forbids secrets in
files; CFG-3 needs `validate` now. [SPEC](../SPEC.md) section 3 fixes YAML validated with Zod
and Ajv for operation input schemas. Nothing fixes the file layout or the error format.

## Options considered

1. **Layout:** one file per kind with fixed names; any file may hold any top-level list.
2. **Strictness:** strict objects (unknown keys are errors); passthrough.
3. **Line numbers:** none (path only); `yaml` 2.x document nodes with a `LineCounter`.
4. **Secret detection (CFG-5):** strict schemas only; strict schemas plus a key-name
   scan of open objects; value heuristics (entropy, `Bearer …`).
5. **Input schema dialect:** draft-07; 2020-12 (the MCP default for tool schemas).
6. **Reload:** start-only; start plus `SIGHUP` reload that keeps the previous
   configuration on error; database-backed snapshots (Phase 8 `apply`).
7. **Fields a call touches (POL-3) before manifests exist:** none; an operation-level
   `fields_arg` naming the argument whose keys or elements are the fields.
8. **Schemas for limits, approval, notifications, presets** whose behaviour arrives later:
   accept anything; define the fields now.

## Decision

1. Any `*.yaml`/`*.yml` under the directory, recursive, sorted; each has `version: 1`
   and any of `connections`, `operations`, `roles`, `role_mapping`, `presets`,
   `notifications`; IDs unique across files. Operators can split by team or system.
2. Strict everywhere except `upstream` (adapter-specific, fixed in Phase 3) and
   `input_schema` (checked by Ajv).
3. Line and column from the YAML nodes; a missing key points at its parent. Format
   `file:line:column path: message`; messages never echo values.
4. Strict schemas plus a key-name scan of the whole document except `input_schema`
   (argument names such as `page_token` are legitimate there). Value heuristics are
   rejected: false positives on IDs and URLs, and false confidence.
5. JSON Schema 2020-12 through `ajv/dist/2020`, `strict: true`, `ajv-formats`; root must
   be `type: object`. Versions already in the lockfile: `ajv` 8.20.0, `ajv-formats`
   3.0.1, `yaml` 2.9.1.
6. Start plus `SIGHUP`, behind a `ConfigurationHolder`; invalid start configuration is
   fatal. Phase 8 builds `diff`/`apply` and the audited snapshot on top.
7. `fields_arg`; validation requires it to be a required property whenever a grant
   restricts fields, so "argument absent" can never mean "all fields". Phase 4 may
   derive touched fields from the manifest instead.
8. Define them now (`limits` four positive integers; `approval` `required`,
   `record_threshold`, `approver_role`, `allow_widget` default false; presets `id`,
   `package`, `version`; notifications `email` with `to`, `webhook` with
   `url_credential_ref`), so CFG-1 is real and typos are caught. Phases 5, 6 and 9 may
   rename fields before the first release.

`packages/config` depends on `packages/core` for the policy model types, and produces
core-typed values; `core` stays dependency-free. CLI: `mandate-config validate <dir>`
(exit 0 / 1 / 2), root script `pnpm mandate-config`.

Webhook URLs are credentials (chat webhooks embed a token), hence `url_credential_ref`.

## Consequences

- Moving an operation between files is not a change; renaming an ID is.
- A new top-level key needs a schema change (strict), which is the point.
- Several `api` instances reload independently on `SIGHUP`; until Phase 8 the operator
  signals each instance.

## Verified

2026-11-16: `pnpm-lock.yaml` / `node_modules/.pnpm` contain `ajv@8.20.0`,
`ajv-formats@3.0.1`, `yaml@2.9.1`, `jose@6.2.17` (already transitive dependencies of the
MCP SDK and tooling, so no new packages enter the supply chain).
