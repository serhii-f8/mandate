# ADR 0021: Configuration loader rules for the operation registry

- Status: Accepted
- Date: 2026-11-16

Extends [ADR 0015](0015-configuration-format-and-loader.md) and [ADR 0017](0017-upstream-configuration-registry-and-read-path.md).

## Context

Building the operation registry raised questions about the configuration loader that
ADR 0015 and ADR 0017 left open. This record lists the answers.

## Options considered and decisions

| Question | Options | Decision |
| --- | --- | --- |
| Loader API | keep `loadConfigurationSources` synchronous and load presets/specs elsewhere; make it async | **Async**, with `LoadOptions.baseDir` for relative spec paths: presets and spec files are configuration and belong to the same all-or-nothing load (CFG-2) |
| `credential_ref` without `auth` | allow (scheme unknown); require `auth` (or a preset default) | **Require**: the page form and `parseSecret` need the scheme; the development and test configurations now say `auth: { scheme: bearer }` |
| A grant naming an operation an override disabled | issue; accepted | **Accepted**: disabling must not force editing every role; the engine ignores grants for absent operations. A connection test naming a disabled operation is an issue |
| Issues that follow from a preset that failed to load or was not checked | report all; suppress dependent "not defined" issues | **Suppress** dependent issues (grants, overrides, tests, `credential_ref requires auth` on that connection); the load still fails or reports "not fully checked", so nothing is accepted on partial information |
| Connection `openapi.spec` and preset `spec` both present | preset wins; connection wins | **Connection wins** (an operator can point a preset at a newer spec); preset specs must be files inside the preset directory |
| URL specs and the configuration hash | fetch in the loader; hash the URL only | **URL only**; the content is fetched by the resolver through the egress guard, its host is the connection's only extra allowed host |
| Operations referencing `upstream.operation` without a resolver | placeholder binding; no binding | **No binding**, placeholder schema, `specChecksSkipped`; `mandate-config validate` says so, `mandate validate` (api) checks fully |
| Spec size limit in the loader | none; 5 MB | **5 MB**, the adapter's limit |
| `mandate-config validate` without preset directories | fail; skip | **`MANDATE_PRESET_DIRS` or `--preset-dir`; otherwise skip preset checks and say so** |
| Wrong value reported as "is required" (Zod 4 omits the input) | leave; `reportInput: true` and keep messages value-free | **`reportInput`**; messages still never quote values |

## Consequences

- Configurations that set `credential_ref` must also set `auth` (or bind a preset with a
  default); this is the only change to existing files.
- The static CLI can report "not fully checked"; operators run `mandate validate` in the
  api image for the authoritative answer.

## Verified

`packages/config` tests (registry, presets, holder reload with a vanished spec, CLI);
`pnpm mandate-config validate deploy/config` exit 0.
