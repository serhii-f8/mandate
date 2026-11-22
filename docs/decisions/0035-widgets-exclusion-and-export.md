# ADR 0035: Widgets, item exclusion and export

- Status: Accepted
- Date: 2026-11-18

## Context

Phase 7 delivers the shared component library and its dual build (UI-1, UI-6), the preview,
progress and result widgets (UI-3, UI-4, MCP-5, MCP-6), item exclusion and export (CS-5, CS-8),
and the widget side of APR-8. The questions below were answered from SPEC,
[ADR 0005](0005-mcp-apps-widgets-and-fallback.md), [ADR 0008](0008-approval-in-widgets-is-opt-in.md) and the code.

## Options considered

| Question | Options | Decision |
| --- | --- | --- |
| How exclusion yields a new hash (CS-5) | (a) new derived change-set, source untouched; (b) new change-set and the source superseded (`cancelled`); (c) re-prepare from upstream with an exclusion argument | **(a)**: no upstream read, no state change on the source, copy in one SQL statement; (b) adds a transition, a wake and a failure mode for no safety gain; (c) re-reads upstream and can change `before` values the requester already saw |
| Where derivation runs | (a) `api`, core service on ports, then start the workflow, whose `prepare` returns at once on `prepared`; (b) a new workflow input or activity mode | **(a)**: no workflow command change, no `patched()`, no new history ([workflow conventions](../conventions/temporal-workflows.md)); signal-with-start on execution covers a failed workflow start |
| Expiry of the derived change-set | (a) copy the source's; (b) fresh period | **(a)**: deriving must not extend the life of stored `before` values (CS-6, CS-7) |
| Re-including items | (a) allow `include` for items excluded with reason `requester`; (b) exclude only | **(a)**: the widget's checkboxes go both ways; CS-3 exclusions stay final |
| Exclusion reason | (a) new reason `requester` in the existing free-text column; (b) a separate column | **(a)**: the reason is already part of the hash line; no hash format change |
| XLSX writer | (a) `exceljs` 4.4.0; (b) own SpreadsheetML over `fflate` 0.8.3 streaming ZIP; (c) own ZIP writer | **(b)**: `exceljs` last released 2023 and heavy; `fflate` is small, streaming, published 2026-05-16; own ZIP code is avoidable risk |
| Formula injection in exports | (a) prefix `'` for cells starting with `= + - @ \t \r`, inline strings in XLSX; (b) none | **(a)** (SEC-5) |
| Export in a widget | (a) open the trusted page (`openLink`) whose buttons download; (b) `downloadFile` with the file pushed through a tool result; (c) a signed URL | **(a)**: needs the page session anyway, no file through the model's connection, no bearer-in-URL; (b) depends on a host capability and moves item data through the chat |
| Submit on the page | (a) one submit service for tool and page; (b) page without submit | **(a)**: UI-1's page entry uses REST, UI-3 needs submit; the session holds the groups POL-6 needs; no fresh login (SEC-8 does not list it) |
| UI resources (refines [ADR 0005](0005-mcp-apps-widgets-and-fallback.md) decision 1) | (a) one resource per view; (b) one per widget entry that switches views by status | **(b)**: a tool links exactly one resource, and one change-set goes through preview, progress and result in one widget; views stay separate components (UI-1) |
| Missing widget bundle at start | (a) fail start; (b) warn, do not list or link it, text fallback | **(b)**: MCP-6 text always works; a missing bundle must not take the endpoint down |
| Audit of `resources/*` | (a) audit every read; (b) none | **(b)**: bundles carry no data and are the same for every caller; AUD-1 names tool-list requests, not resource reads |
| Approver's widget tool | (a) new read tool `review_changeset` for approvers, page detail builder, `canDecide` for channel `widget`; (b) reuse `get_changeset` | **(a)**: `get_changeset` is requester only; APR-5 needs the stored approval view |
| MCP-6 for results without a change-set | (a) every result carries a URL; (b) only results that refer to a change-set | **(b)**: a refusal before any change-set exists has no page; SPEC MCP-6 reworded |
| Widget polling | (a) 3 s throughout; (b) 3 s for a minute, then 10 s, stop after 30 min | **(b)**: each poll is an audited tool call |
| UI-4 rollback action | (a) build it now against a missing tool; (b) the result view has the button behind `rollback.available`, wired in Phase 8 with `rollback_changeset` | **(b)**: rollback is Phase 8's EXE-8; Phase 8 also delivers this part of UI-4 |
| ext-apps version | (a) 2.0.4 (used in the Phase 0 experiment); (b) 2.1.0 | **(b)**: current, older than two weeks, same peers |
| Acceptance of criteria 1 and 2 | (a) manual only; (b) an automated reference host in headless Chromium plus the manual checks | **(b)**: automated evidence for everything but the real clients; the checks in the real clients stay manual |

## Decision

As in the table. SPEC changes:

- **MCP-6** reads: "Include a fallback HTTPS URL to the trusted page in the text content of every
  result of a tool that declares a widget, when the result refers to a change-set. …".
- **Phase 8** list names the result view's rollback action (UI-4) with `rollback_changeset`.

Further points fixed with the decisions above: the refactoring of submit into one service is
pure (no behaviour change); result fields are added, never changed; drift is reported in
structured data; the views take view models with per-entry adapters; the acceptance run
reconfigures by SIGHUP; the update guard's trigger body starts from migration 0009; the widget
poll backs off.

## Consequences

- A requester can hold several prepared change-sets derived from one request; approvers see only
  what is submitted. Migration 0011 adds `change_set.derived_from` and extends the update guard
  (from its 0009 body).
- `fflate` becomes an `api` dependency; `@modelcontextprotocol/ext-apps`, `vite-plugin-singlefile`
  become `widgets` dependencies; Playwright a tooling dev dependency for acceptance.
- The widget bundles ship in the image next to the web bundle (`AIOPS_WIDGET_DIR`).
- Widget approval stays opt-in and excluded for step-up and destructive change-sets: the widget
  only renders decision buttons when the server computed `canDecide` for channel `widget`, and
  `decide_changeset` re-checks everything ([ADR 0008](0008-approval-in-widgets-is-opt-in.md)).

## Verified

- 2026-11-18, `npm view @modelcontextprotocol/ext-apps versions time peerDependencies`: 2.1.0
  published 2026-10-27T08:31:59Z; peers `@modelcontextprotocol/client|core|server ^2.0.0`, `react`
  and `react-dom` `^17 || ^18 || ^19`, `zod ^4.2.0`.
- 2026-11-18, `npm pack @modelcontextprotocol/ext-apps@2.1.0`, read `dist/src/app.d.ts`: `App`
  has `callServerTool`, `openLink` (answers `isError` when the host refuses), `downloadFile`
  (host-mediated, `McpUiHostCapabilities.downloadFile`), `updateModelContext`, `ontoolresult`,
  `onhostcontextchanged`, `onteardown`; `dist/src/constants.d.ts`: `RESOURCE_MIME_TYPE =
  "text/html;profile=mcp-app"`, `RESOURCE_URI_META_KEY = "ui/resourceUri"`;
  `dist/src/server/index.d.ts`: `registerAppTool` writes both `_meta.ui.resourceUri` and the
  legacy key, `registerAppResource` takes `_meta.ui` (`csp`, `prefersBorder`), extension ID
  `io.modelcontextprotocol/ui`; `dist/src/spec.types.d.ts`: `McpUiResourceCsp` empty → no network.
- 2026-11-18, `@modelcontextprotocol/server` 2.4.0 `dist/src-DdvbAHrR.mjs`: the enum has
  `ResourceNotFound = -32002`, but the SDK never emits it; `ResourceNotFoundError(uri)` extends
  `ProtocolError` with `ProtocolErrorCode.InvalidParams`, so a `resources/read` miss goes on the wire
  as `-32602` with `data: { uri }`. The server uses that error.
- 2026-11-18, `npm view fflate time`: 0.8.3 published 2026-05-16; `npm view exceljs`: 4.4.0,
  registry document last modified 2024-12-20; `npm view vite-plugin-singlefile`: 2.3.4, peer
  `vite ^5.4.21 || ^6 || ^7 || ^8`; `npm view playwright version`: 1.65.1 (browsers cached
  locally, used by a Phase 0 experiment).
- Code read 2026-11-18: `runPreparation` returns at once for a `prepared` change-set
  (`packages/core/src/changeset/prepare.ts`); the update guard was last replaced in
  `packages/db/migrations/0009_approvals.sql`; the hash line includes `reason`
  (`packages/core/src/changeset/hash.ts`); `web_session.groups` exists
  (`packages/db/src/schema.ts`).
