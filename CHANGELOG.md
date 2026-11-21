# Changelog

All notable changes are recorded here. The project follows [semantic versioning](docs/guide/versioning.md).

## 1.0.0

First stable release. The connector SDK and the configuration schema are now public, versioned
interfaces (see [Versioning](docs/guide/versioning.md)).

### Upgrade notes

Read these before you upgrade from a release before 1.0.

- **Re-run `config apply` after upgrading.** The configuration hash now covers more than before (see the
  Magento preset item below), and preset code changed. A stored revision from before the upgrade is
  refused with `configuration_mismatch` until you run `config diff` and `config apply` again.
- **Stricter loading of opaque and bulk operations.** The loader refuses a `write_opaque` grant without
  approval steps (unless the role says `required: never`), an opaque `GET` or `bulk` binding, and a bulk
  write on a destructive operation without a manifest. A configuration that loaded before can now be
  refused; fix the key the error names.
- **Magento preset hash.** The Magento preset's `package.json` gained an `aiops` block, which changes the
  configuration hash. See the first item: re-run `config apply`.
- **MCP tools with schemas that fail strict validation.** An MCP tool whose own schema does not pass the
  strict Ajv check needs an operator-supplied `input_schema` on its operation.
- **`config diff` and `disabled ~`.** For an MCP connection, `config diff` can print `disabled ~` lines.
  They follow the live tool list of the upstream, so they can appear or move without any change to your
  files.
- **Servers that mirror parameters in headers.** An MCP server that requires mirrored `Mcp-Param`
  headers refuses opaque calls.
- **Gitea credential.** The Gitea credential is the bare token, entered on the credential page:
  paste the bare access token, not `token <t>`. The adapter sends it as `Authorization: Bearer <t>`.
- **Connector SDK range moves from 0.6 to 1.0.** The SDK is now 1.0.0, and the two shipped presets
  declare `aiops.sdk` as `^1.0.0`. A preset you wrote for the 0.6 SDK declares `^0.6.0`, which does not
  match 1.0.0: the loader refuses it with `preset_sdk_incompatible`. Rebuild and re-test it against the
  1.0 SDK, then set its range to `^1.0.0`.

### Added

- Versions 1.0.0 for the product, the connector SDK (`@aiops/connector-sdk`), the configuration schema
  and both shipped presets (`@aiops/magento2-catalog`, `@aiops/gitea-issues`).
- Committed public surface reports, `packages/connector-sdk/api-report.d.ts`,
  `packages/config/schema/aiops-config.v1.json` and `packages/config/schema/aiops-preset.v1.json` (the
  preset format), and a semver gate in CI that compares them with the base branch.
- A `version` field in the `/healthz` answer of the `api` and the `worker`: `{"ok":true,"version":"1.0.0"}`.
- The user guide in `docs/guide/`: installation, connecting Magento, roles and approvals, a first bulk
  update, backup and restore, configuration reference, presets, MCP upstreams, service accounts,
  upgrading, production hardening, operations and versioning.
- A commented example configuration in `examples/config/` and a contract-tested preset template in
  `examples/`.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `SECURITY.md`.

### Changed

- **OpenTelemetry 2.x.** The `api`, the `worker` and the upstream package moved to the OpenTelemetry JS
  SDK 2.12 and exporters 0.223 to clear two high advisories. The Prometheus series keep their names and
  labels. OTLP trace exports now give up after 2 seconds, so a collector that is down no longer delays
  shutdown. Workflow spans keep their parent linkage through an adapter for the Temporal plugin, which
  keeps its own 1.x SDK internally. See ADR 0054.
- The project is licensed under the Apache License 2.0 (`LICENSE`, `NOTICE`), and every source file
  carries an SPDX header.

### Security

- A dependency gate in CI blocks high advisories; the OpenTelemetry upgrade above cleared the two that
  blocked it.
