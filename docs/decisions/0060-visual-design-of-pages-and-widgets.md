# ADR 0060: Visual design of the trusted pages and widgets

- Status: Accepted
- Date: 2026-11-21

## Context

The trusted pages (`apps/web`) had a 7-line stylesheet and no page frame. The shared view stylesheet
(`packages/widgets/src/styles.css`) was scoped to `.aiops`, but no element had that class, so neither
the pages nor the MCP Apps widgets applied any of it.

Constraints: the pages are served with `default-src 'self'`, so fonts and styles must be bundled;
the widget stylesheet may use only MCP Apps style variables, each with a fallback, and may load
nothing (UI-6, `styles.test.ts`); widgets hold no authority, so the change is presentation only.

## Options considered

1. Style the pages only and leave the widgets bare. Rejected: the approval and change-set views are
   the same components on both surfaces (UI-1).
2. Give pages and widgets separate stylesheets. Rejected: the styles would drift apart.
3. Keep one shared stylesheet, written only against the MCP Apps variables. The pages set those
   variables to their own palette; inside a host, the host sets them. Chosen.

## Decision

- `#root` carries `class="aiops"` in `apps/web/index.html` and both widget entries. This turns the
  shared stylesheet on.
- Shared views: section rhythm, status pills coloured by state group (waiting, running, done,
  failed, inactive), segmented filters and tabs, tinted before/after cells (`td.before`, `td.after`),
  a monospace hash, and a marked Decision panel. Buttons get `primary` (approve, submit, start,
  save) or `danger` (reject, cancel, roll back) classes. Labels and accessible names are unchanged.
- Pages: a masthead with the product name and the Approvals and Credentials links; a page column
  (72rem, or 44rem for reading pages); change-sets and credentials shown as sheets; the Decision
  panel as the one emphasised element, in the seal colour `#1D5E57`. The palette is cool paper and
  ink, with oxblood for refusal and amber for waiting. Light and dark schemes follow
  `prefers-color-scheme`.
- Type: Public Sans (OFL-1.1), self-hosted through `@fontsource-variable/public-sans` 5.2.6 and
  bundled by Vite into `/app/assets`, which the CSP allows. Monospace is used only for machine
  values (hashes, IDs, timestamps, before/after values). The widgets use the host's `--font-sans`.
- The index page states what each page is for.

## Consequences

- Inside an MCP Apps host, the widgets look native to it; on the trusted pages, the same views carry
  the page palette.
- The `primary`/`danger` classes and `td.before`/`td.after` are styling hooks only. Tests still find
  controls by role and name.

## Verified

- Screenshots of every page on the local Compose stack (desktop light, 390 px dark and light), and
  `bash scripts/ci.sh`, which passed (2026-11-21).

## Addendum 2026-11-21: host theme, empty and closed states

- Verified: `@modelcontextprotocol/ext-apps` 2.1.0 `useHostStyleVariables` calls `applyDocumentTheme`,
  which sets `document.documentElement.style.colorScheme` to the host theme
  (`dist/src/react/index.js`). `color-scheme` is now declared on `:root` only (it was on `.aiops`,
  which overrode the host theme). Tints and secondary-background fallbacks are mixed from text
  colours with `color-mix(... transparent)`, so they stay legible on any host background. Seen in
  the reference host (`tooling/acceptance/widget-host`), whose fixture sends dark colours under
  `theme: 'light'`.
- An empty result tab says "No failed items." / "No skipped items." once its first page has loaded.
- With nothing left to decide or start, the Decision part says "Nothing to decide: this change-set is
  <status>." and is not marked; the marked style (`section.decision.open`) is used only while a
  decision or a start is open.
