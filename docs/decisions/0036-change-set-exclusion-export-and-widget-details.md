# ADR 0036: Change-set exclusion, export and widget details

- Status: Accepted
- Date: 2026-11-18

## Context

Phase 7 adds change-set exclusion and export, the widget views and the MCP tools and resources
that link them. [ADR 0035](0035-widgets-exclusion-and-export.md) holds the main decisions. Building the three parts (the
change-set core and page routes, the views, the MCP layer) raised smaller questions where the
parts meet (shapes, names) or where a wrong guess would change security or audit behaviour. This
record lists the answers in one place. They refine ADR 0035. The rulings are numbered R1 to R23;
ruling F1 was added while the widget bundles were built.

## Options considered

Each ruling had the alternative of leaving the question open until the code was written. That was
rejected where two parts meet (shapes, names) or where a wrong guess changes security or audit
behaviour.

## Decision

**Change-sets.**

- **R1.** `invalid_request` is a core refusal of `deriveChangeSet`, after `hash_mismatch`: more
  than 1000 IDs, or an ID that is empty, longer than 512 characters or holds control characters.
  The page answers it `400 { error: 'invalid_body' }`, the tool with a fixed text.
- **R2.** Duplicate IDs count once; a target in both `exclude` and `include` counts as unknown.
- **R3.** Page calls audit under three new actions `changeset.submit`, `changeset.exclude`,
  `changeset.export`, one `ok` or `denied` row per call, details `channel: 'page'`.
- **R4.** Export columns interleave per field: `before.f`, `after.f`. Header cells get the formula
  prefix too.
- **R5.** The `policy.decision` row of a page submit names the tool `submit_for_approval` (same
  logic, MCP-8); the page's own row carries `channel: 'page'`.
- **R6.** The `exclude_changeset_items` text ends with the prepared result's fixed sentences; the
  MCP layer appends `Open: <url>`.
- **R7.** The page submit answer's `approval.steps` is the list of role names, as in the tool.
- **R8.** The workflow starter moves into its own provider, shared by the MCP factory and the page
  exclusion route. Adding a built-in tool changes the expected tool lists of the `policy`,
  `read-path` and `keycloak` e2e tests and of `scripts/acceptance/phase-2.sh`; they are updated.
- **R9.** The worker's `prepare` activity returns early for any status other than `preparing`, so
  a derived change-set's workflow never re-prepares (the reason ADR 0035 gave, at the activity).

**Views.**

- **R10.** `apps/web/tsconfig.json` drops `customConditions: []` so it type-checks
  `@aiops/widgets` from source; the web Vite config dedupes `react`.
- **R11.** The `no-raw-html` test stays in `apps/web` and gets a copy in `packages/widgets`; lint
  rules for widgets cover `.tsx`.
- **R12.** The single-file build sets Vite `root: 'src/widget'`, so bundles land in `dist/ui/`.
- **R13.** The change-set widget also polls while `pending_approval`, so it updates after a page
  approval.
- **R14.** The image copies the bundles to `/app/widgets`; `AIOPS_WIDGET_DIR` is set there.
- **F1.** The bundle check (`packages/widgets/scripts/check-bundles.mjs`) and the build test apply
  the `url(` and `@import` checks to the contents of `<style>` blocks only. `<script ... src=`,
  `<link`, `<img` and the `<!doctype html` start stay whole-document checks. The intent of the
  check is CSS loading, and zod's `.url(` method is inside every correct bundle.

**MCP.**

- **R15.** Unknown resource URIs answer the SDK's `ResourceNotFoundError` (`-32602`, `data.uri`);
  ADR 0035 "Verified" records the check.
- **R16.** The fallback link is added to linked tools' results whether or not the bundle is
  present (the text fallback matters most when it is not).
- **R17.** Refusals about a change-set the caller can see carry `{ changesetId }` in
  `structuredContent`, so they get the link.
- **R18.** When `pageUrl` is added, the JSON text block is rewritten with it (e2e tests compare
  the two).
- **R19.** `review_changeset` answers
  `{ changesetId, detail, items: ItemRow[], nextCursor?, sample: { seed, items }, pageUrl }`,
  matching the widgets' `review-changeset.json` fixture; `detail.viewer` is computed for channel
  `widget`.
- **R20.** Acceptance excludes one of **4** SKUs (3 remain, above `record_threshold: 2`), so the
  derived change-set needs approval.
- **R21.** `cancel_changeset` keeps `changeset.id` in its answer and links no widget.
- **R22.** In the development realm alice also holds an approver role, so her tool list gains
  `review_changeset`; `phase-2.sh` expects it.
- **R23.** The acceptance host runs headless Chromium; Node forwards the widget's tool calls with
  the user's token, so the browser never holds a token. `tooling` gains Playwright 1.65.1, Vite,
  `vite-plugin-singlefile` and ext-apps 2.1.0 as dev dependencies.

## Consequences

- The change-set core, the views and the MCP layer agree on tool names, answer shapes and the
  audit actions.
- Three new audit action names (`changeset.submit`, `changeset.exclude`, `changeset.export`) join
  AUD-1's list; Phase 8's audit search must know them.

## Verified

- 2026-11-18, `@modelcontextprotocol/server` 2.4.0 `dist/src-DdvbAHrR.mjs`:
  `ResourceNotFoundError` calls `super(ProtocolErrorCode.InvalidParams, message, { uri })`.
- 2026-11-18, code read: `apps/web/tsconfig.json` (`customConditions: []`),
  `apps/api/src/mcp/submit-tool.ts:157` (inline page URL), the worker `prepare` activity's early
  return, the tool-list expectations in the three e2e tests and `phase-2.sh`.
