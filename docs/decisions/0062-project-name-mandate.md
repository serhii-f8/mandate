# ADR 0062: The project is named Mandate

- Status: Accepted
- Date: 2026-11-22

## Context

The project was developed under the working title "AI Operations Layer", with the short form
`aiops` in package names, environment variables, the command line and wire identifiers. "AIOps" is
an established term for a different field (machine learning applied to IT operations), so the
short form misdescribes the product and hides it in search results. Version 1.0.0 had not been
published when the name was chosen, so no installation depended on the old identifiers.

## Options considered

1. Rename only the repository and the documentation; keep `aiops` in code and configuration.
2. Rename everything, including identifiers that take part in hashes and database settings.

## Decision

Option 2. The name is **Mandate**: an AI client acts only within what a role is authorised to do,
and a write happens only once a person has approved it.

- Package scope `@mandate/*`; command line `mandate`; environment prefix `MANDATE_`; Compose
  project `mandate`; Keycloak realm `mandate` with clients `mandate-mcp` and `mandate-web`;
  widget resources `ui://mandate/...`; schema files `mandate-config.v1.json` and
  `mandate-preset.v1.json`.
- Hash format tags are renamed with the rest: `mandate.changeset.v1`, `mandate.audit.v1` and
  `mandate.mcp-tool.v1`. Hashes and pins computed under the old tags do not verify under the new
  ones.
- The PostgreSQL settings used by the audit triggers are renamed in migration 0013
  (`mandate.audit_seal`, `mandate.audit_retention`). Editing a migration is otherwise forbidden;
  it is allowed here only because no released version carried the old one.
- The public surface reports changed their header names. The semver gate treats a base report
  whose version header it cannot read as a new report, so the renaming commit passes without a
  major version bump; the versions stay 1.0.0.

## Consequences

- A database, a configuration revision, a pinned MCP tool or an audit chain created by a build
  from before the rename does not work with a build after it. Development installations start
  from empty volumes.
- Committed Temporal workflow histories had the recorder's task queue name renamed as text. The
  replay test passes over every history.
- The fixed test vectors of the audit hash chain changed, because the format tag is part of the
  hashed bytes.

## Verified

2026-11-22: `bash scripts/ci.sh` passes after the rename (lint, type-check, build, public API
reports and semver gate, unit, integration including the replay gate, end-to-end).
