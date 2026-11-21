# Versioning

This page says what you can rely on when you upgrade, and how breaking changes are announced.
The product follows [semantic versioning](https://semver.org). The current release is 1.0.0.

## What is versioned

Four things carry a version, and two of them are public interfaces with a written contract.

| Artifact | Version | Where you see it | Public contract |
| --- | --- | --- | --- |
| Product (`api`, `worker`, images) | 1.0.0 | `version` field of `GET /healthz`; image label `org.opencontainers.image.version` | The behaviour this guide describes |
| Connector SDK (`@aiops/connector-sdk`) | 1.0.0 | package version; `CONNECTOR_SDK_VERSION` | `packages/connector-sdk/api-report.d.ts` |
| Configuration schema | 1.0.0 | `CONFIG_SCHEMA_VERSION`; the `version: 1` line of every YAML file is its major | `packages/config/schema/aiops-config.v1.json` |
| Presets (`@aiops/magento2-catalog`, `@aiops/gitea-issues`) | 1.0.0 | package version | Each preset's `aiops.sdk` range |

```bash
curl -fsS "http://localhost:${AIOPS_API_PORT:-8400}/healthz"
```

The answer is `{"ok":true,"version":"1.0.0"}`. The worker answers the same on its health port.

## The rules

- **Patch** (1.0.x): fixes. No change to either public interface.
- **Minor** (1.x.0): additions only. A new optional configuration key, a new export of the SDK, a new
  operation field. A configuration that loaded before still loads, and a preset built for the same
  major still loads.
- **Major** (x.0.0): anything that removes or changes a public name, type, key or meaning. The YAML
  `version` literal changes only with a major version of the configuration schema.

The product version moves with the highest of the other changes in a release.

## Reports and the gate

The two contracts are committed as generated files, so a change to them shows up in review:

- `packages/connector-sdk/api-report.d.ts`: every declaration reachable from the SDK entry, with
  comments removed. Its first line names the SDK version.
- `packages/config/schema/aiops-config.v1.json`: the JSON Schema of the root configuration object. It
  carries `x-aiops-schema-version`. Editors can use it for completion and validation: start a YAML file
  with `# yaml-language-server: $schema=...` pointing at it.

CI regenerates both and fails when a file is stale (`--check`). A semver gate then compares each report
with the one on the base branch:

| Change to a report | Required version change |
| --- | --- |
| none | none |
| only added lines | a higher minor (or major) |
| any removed or changed line | a higher major |

The gate is a heuristic that backs up review: it sees names and shapes, not meaning. A change in what
a field means is a breaking change even if the report does not move.

## Deprecation

No name is deprecated in 1.0.0. This is the policy for future deprecations. A public name is never
removed without notice:

1. A minor release marks it deprecated. It keeps working, the CHANGELOG and this guide name its
   replacement, and the loader or the SDK warns when it is used.
2. The next major release may remove it.

So code and configuration that run without warnings on the last minor of a major keep working on the
next minor of that major.

## Presets and the SDK range

A preset package declares the SDK range it was built for in its `package.json`:

```json
{ "aiops": { "sdk": "^1.0.0" } }
```

When the configuration loader loads a preset it checks the SDK version of the running platform against
that range. A mismatch is a configuration error, `preset_sdk_incompatible`, and the configuration is
refused before anything runs. A preset with `^1.0.0` loads on every 1.x platform and is refused on 2.0.
Presets before 1.0 declared `^0.6.0`; that range does not match 1.0.0, so a preset you wrote earlier
needs its range changed, and a rebuild, after you upgrade. See [Presets](presets.md).

## Running workflows and upgrades

Change-sets execute as Temporal workflows that may wait days for an approval. A new release must not
break a workflow that started under the old one. Any change to the commands of a deployed workflow type
goes behind a Temporal patch marker, and CI replays every committed workflow history against the new
code, so a change that would break an open execution fails the build. Patch markers are removed only
after every execution that could have passed them has closed. The binding rules are in
[CONTRIBUTING.md](../../CONTRIBUTING.md#temporal-workflow-versioning); for what this means when you
upgrade, see [Upgrading](upgrading.md).

Database migrations are forward-only and run when the `api` and `worker` start. Never edit one. To go
back, restore a backup (see [Backup and restore](backup-and-restore.md)).

## Background

- [ADR 0053](../decisions/0053-release-readiness.md): why the reports and the gate exist, and what
  1.0.0 covers.
- [ADR 0006](../decisions/0006-temporal-workflow-versioning.md): the workflow versioning convention.
