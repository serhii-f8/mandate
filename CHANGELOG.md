# Changelog

All notable changes are recorded here. The project follows [semantic versioning](docs/guide/versioning.md).

## 1.2.0

Upgrade every `api` and `worker` before preparing new change-sets. See
[Upgrading](docs/guide/upgrading.md#upgrading-to-120).

### Added

- Change-sets record the version of their hash format and their manifest action (`hash_version`,
  `action`, migration `0015`); new change-sets use version 2, which binds the action into the hash,
  and change-sets prepared before the upgrade keep verifying under version 1 (CS-4, ADR 0069).

## 1.1.0

Additive release: the connector SDK (1.1.0) and the configuration schema (1.1.0) gain optional members
only. One step on upgrade: the image ships the Magento preset 1.1.0 only, so a configuration that pins
`@mandate/magento2-catalog` with `version: '1.0.0'` (as the shipped `deploy/config/connections.yaml`, the
preset README and the Magento guide told you to write) no longer resolves and `config apply` fails.
Change the pin to `'1.1.0'` or `'^1.0.0'`. A preset of your own that starts using `params` must declare
`mandate.sdk: ^1.1.0`. See [Upgrading](docs/guide/upgrading.md#upgrading-to-110).

### Added

- `rate.requests_per_second` on a connection paces its upstream requests, retries included, and a
  `Retry-After` the client honours holds the whole connection (CONN-6, ADR 0064).
  `ConnectionSettings.minIntervalMs` carries it to adapters.
- `auth.scheme: oauth_password` (with `client_auth: basic | body`) fetches upstream tokens with the OAuth
  password grant, for upstreams that offer nothing else. The credential scheme `oauth_password`
  is appended to `CREDENTIAL_SCHEMES` and `AuthSettings` gains the matching variant (CONN-3, ADR 0065).
- `auth.scheme: oauth1` signs each upstream request with OAuth 1.0a (`signature_method: HMAC-SHA256 | HMAC-SHA1`),
  for upstreams such as Magento 2 integrations. Not available on `mcp` connections. The credential scheme
  `oauth1` is appended to `CREDENTIAL_SCHEMES` and `AuthSettings` and `SecretMaterial` gain variants
  (CONN-3, ADR 0065).
- `grants[].approval` and `approval.field_rules` route approval per grant and per touched field: a grant's
  rule replaces the role's, and the first field rule naming a touched field replaces that. Submission, the
  execution guard and `config explain` use the same resolution (POL-5, ADR 0066). A field rule naming a
  field that the operation's closed fields argument does not list is refused.
- Presets declare typed parameters with defaults (`params` in `preset.yaml`), and a connection sets them
  with `preset_params`; `{ $param: <name> }` nodes in the preset's operations and test take the
  connection's value. Code operations receive the values as `ctx.params`, carried by
  `ConnectionSettings.presetParams` (CONN-8, ADR 0067). An operation's `id`, `fields_arg` and
  `manifest.values_arg` and the test's `operation` cannot be parameters. The preset template is 1.1.0.
- `@mandate/magento2-catalog` 1.1.0 takes the parameters `scope_attribute` (default `brand`) and `read_fields`
  (default the 1.0.0 field list); without them it behaves as 1.0.0. It requires connector SDK `^1.1.0`
  (CONN-8).

## 1.0.1

A maintenance release. No upgrade steps: the connector SDK, the configuration schema and both
presets stay at 1.0.0.

### Changed

- Dependencies: Temporal SDK 1.26.0, NestJS 12.5.1, OpenTelemetry 2.12.1 and 0.223.2 (patches within
  the 2.x line), jose 6.2.18, nodemailer 10.6.0.
- Build and CI: vitest 5.1.1, turbo 2.11.13, `actions/checkout` and `actions/setup-node` v7.

### Fixed

- A unit test bounded 10,000 policy evaluations to 200 ms and failed on shared CI runners. The
  bound is now 2 s.
- Three integration tests that stop a worker by force matched an error text that Temporal SDK
  1.26 no longer reports first. They now match the timeout error the SDK raises.

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
- **Magento preset hash.** The Magento preset's `package.json` gained an `mandate` block, which changes the
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
  declare `mandate.sdk` as `^1.0.0`. A preset you wrote for the 0.6 SDK declares `^0.6.0`, which does not
  match 1.0.0: the loader refuses it with `preset_sdk_incompatible`. Rebuild and re-test it against the
  1.0 SDK, then set its range to `^1.0.0`.

### Added

- Versions 1.0.0 for the product, the connector SDK (`@mandate/connector-sdk`), the configuration schema
  and both shipped presets (`@mandate/magento2-catalog`, `@mandate/gitea-issues`).
- Committed public surface reports, `packages/connector-sdk/api-report.d.ts`,
  `packages/config/schema/mandate-config.v1.json` and `packages/config/schema/mandate-preset.v1.json` (the
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
