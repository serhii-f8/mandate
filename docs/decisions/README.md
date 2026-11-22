# Decision records

Architecture decision records (ADRs) explain why the system is built the way it is. Code comments,
tests and documents cite them by number ("ADR 0027", "ADR 0029 decision 3"). Each record has the
sections Context, Options considered, Decision and Consequences, and Verified where something was
checked against a library, a protocol or a running system.

Numbers are stable and are never reused. Numbers missing from this list belong to records about the
internal development process, which are not published. A new decision takes the next free number
after the highest one in this list, a file `NNNN-short-title.md` and a row here.

Requirements cited in the records (`MCP-1`, `POL-3`, `NFR-18`) are defined in the
[specification](../SPEC.md).

| ADR | Title | Date |
| --- | --- | --- |
| [0001](0001-requirement-phase-assignment.md) | Requirement-to-phase assignment and the meaning of "CI is green" | 2026-11-16 |
| [0003](0003-mcp-sdk-and-transport.md) | MCP SDK, transport and long-running operations | 2026-11-16 |
| [0004](0004-authorization-and-client-registration.md) | Authorization server, client registration and token audience | 2026-11-16 |
| [0005](0005-mcp-apps-widgets-and-fallback.md) | MCP Apps widgets and the text + URL fallback | 2026-11-16 |
| [0006](0006-temporal-workflow-versioning.md) | Temporal workflow versioning | 2026-11-16 |
| [0007](0007-magento-bulk-and-idempotency.md) | Magento bulk endpoints and idempotency | 2026-11-16 |
| [0008](0008-approval-in-widgets-is-opt-in.md) | Approval decisions in widgets are opt-in and limited | 2026-11-16 |
| [0009](0009-offline-access-and-observed-client-registration.md) | Offline access in the bundled realm; client registration as observed | 2026-11-16 |
| [0010](0010-toolchain-and-workspace.md) | Toolchain and workspace layout | 2026-11-16 |
| [0011](0011-persistence-package-and-migrations.md) | Persistence package, migrations on start, audit base schema | 2026-11-16 |
| [0012](0012-compose-topology.md) | Docker Compose topology | 2026-11-16 |
| [0013](0013-phase-1-mcp-endpoint.md) | The Phase 1 MCP endpoint | 2026-11-16 |
| [0014](0014-token-verification-and-realm-bootstrap.md) | Token verification, protected resource metadata and the realm bootstrap | 2026-11-16 |
| [0015](0015-configuration-format-and-loader.md) | Configuration format, loader and `validate` | 2026-11-16 |
| [0016](0016-policy-evaluation-and-mcp-enforcement.md) | Policy evaluation and enforcement in the MCP pipeline | 2026-11-16 |
| [0017](0017-upstream-configuration-registry-and-read-path.md) | Upstream configuration, operation registry and the direct read path | 2026-11-16 |
| [0018](0018-openapi-adapter-egress-and-redaction.md) | OpenAPI adapter: spec handling, egress guard, redaction | 2026-11-16 |
| [0019](0019-credential-vault-and-trusted-page-sessions.md) | Credential vault and trusted-page sessions | 2026-11-16 |
| [0021](0021-configuration-loader-registry-rules.md) | Configuration loader rules for the operation registry | 2026-11-16 |
| [0022](0022-login-state-bound-to-the-browser.md) | Login state is bound to the browser | 2026-11-16 |
| [0023](0023-read-path-configuration-guards.md) | Configuration guards for the direct read path | 2026-11-17 |
| [0024](0024-change-set-preparation-and-manifests.md) | Change-set preparation, manifests and the executor interface | 2026-11-17 |
| [0026](0026-update-content-target-selection-without-root-combinators.md) | update_content names its targets without a root-level combinator | 2026-11-17 |
| [0027](0027-execution-on-temporal.md) | Execution on Temporal: workflow, writes, Tasks and starting execution | 2026-11-17 |
| [0028](0028-workflow-and-batch-write-rulings.md) | Rulings for the change-set workflow and the batch writer | 2026-11-17 |
| [0029](0029-mcp-tasks-rulings.md) | Rulings for MCP Tasks and the api execution path, and a correction to ADR 0027 | 2026-11-17 |
| [0030](0030-approvals-pages-and-notifications.md) | Approvals, trusted approval pages and notifications | 2026-11-17 |
| [0032](0032-approval-page-routes-rulings.md) | Rulings for the approval decision and start routes and the page API | 2026-11-17 |
| [0034](0034-notification-delivery-rulings.md) | Notification delivery rulings | 2026-11-18 |
| [0035](0035-widgets-exclusion-and-export.md) | Widgets, item exclusion and export | 2026-11-18 |
| [0036](0036-change-set-exclusion-export-and-widget-details.md) | Change-set exclusion, export and widget details | 2026-11-18 |
| [0041](0041-widget-acceptance-on-local-reference-host.md) | Widget acceptance is verified on a local reference host | 2026-11-18 |
| [0042](0042-rollback-audit-configuration-observability.md) | Rollback, audit chain, configuration apply and observability | 2026-11-18 |
| [0043](0043-rollback-audit-configuration-observability-details.md) | Rollback, audit, configuration and observability details | 2026-11-18 |
| [0047](0047-trace-header-plaintext-w3c-context.md) | The Temporal trace header is plaintext W3C context | 2026-11-19 |
| [0050](0050-mcp-upstream-opaque-presets-service-accounts.md) | MCP upstream adapter, opaque writes, preset packages, service accounts | 2026-11-19 |
| [0051](0051-mcp-upstream-opaque-presets-service-accounts-details.md) | MCP upstream, opaque writes, presets and service accounts in detail | 2026-11-19 |
| [0053](0053-release-readiness.md) | Release readiness: rate limits, denial suite, CI gates, versioning, documentation | 2026-11-20 |
| [0054](0054-opentelemetry-2x-with-temporal-1x-plugin.md) | OpenTelemetry 2.x beside the Temporal plugin's own 1.x SDK | 2026-11-20 |
| [0055](0055-conformance-baseline-2026-07-28.md) | Conformance baseline for 2026-07-28: per-check entries in must-pass scenarios | 2026-11-20 |
| [0056](0056-conformance-baseline-2025-11-25-legacy.md) | Conformance baseline for 2025-11-25 on the stateless legacy path | 2026-11-20 |
| [0059](0059-documentation-acceptance-by-clean-clone-walkthrough.md) | Acceptance of the public guide by clean-clone walkthroughs | 2026-11-21 |
| [0060](0060-visual-design-of-pages-and-widgets.md) | Visual design of the trusted pages and widgets | 2026-11-21 |
| [0062](0062-project-name-mandate.md) | The project is named Mandate | 2026-11-22 |
| [0063](0063-semver-gate-appended-literals.md) | The semver gate judges an appended literal additive | 2026-11-22 |
| [0064](0064-connection-pacing.md) | Per-connection pacing of upstream requests | 2026-11-22 |
| [0065](0065-upstream-auth-schemes.md) | Upstream auth schemes: OAuth password grant and OAuth 1.0a | 2026-11-22 |
| [0066](0066-approval-routing-per-grant-and-field.md) | Approval routing per grant and per touched field | 2026-11-22 |
| [0067](0067-preset-parameters.md) | Preset parameters bound per connection | 2026-11-22 |
| [0068](0068-semver-gate-relaxed-required.md) | The semver gate judges a key removed from `required` additive | 2026-11-22 |
| [0069](0069-change-set-hash-version.md) | Change-sets record the version of their hash format | 2026-11-22 |
| [0070](0070-per-record-values.md) | A write can carry per-record values | 2026-11-22 |
| [0071](0071-create-and-delete-change-sets.md) | Change-sets can create and delete records | 2026-11-22 |
