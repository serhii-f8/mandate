# ADR 0041: Widget acceptance is verified on a local reference host

- Status: Accepted
- Date: 2026-11-18

## Context

The Phase 7 acceptance criteria 1 and 2 named Claude Desktop and ChatGPT. Both clients reach an
MCP server only over public HTTPS, so checking the criteria there needs two tunnels and a person
at each client. Those checks cannot be automated or repeated from a development machine.

## Options considered

1. Keep the criteria open until someone records manual checks in Claude Desktop and ChatGPT.
2. Verify criteria 1 and 2 on local MCP Apps hosts. The reference host
   `tooling/acceptance/widget-host` runs in headless Chromium and uses `AppBridge` from
   `@modelcontextprotocol/ext-apps` 2.1.0, the host side of the MCP Apps protocol that both
   clients implement. Correct SPEC section 7 to match.
3. Drop the criteria.

## Decision

Option 2. Criteria 1 and 2 count as met when the full flow runs in the local reference host
against the Compose stack and the local Mage-OS sandbox. The flow is
`scripts/acceptance/phase-7.sh`, checks `host-*` and `reconfigure-allow-widget`:

- the tool links the widget resource;
- the preview widget shows 4 rows;
- one row is excluded and the derived change-set is submitted;
- the widget's own fetch is blocked by the host CSP;
- the host theme is applied;
- approval happens on the page;
- the result widget shows 3 written;
- the approval widget is link-only by default and decides only with `allow_widget: true`.

[SPEC](../SPEC.md) section 7, Phase 7 acceptance reads "inside an MCP Apps host (verified locally
with the reference host on the ext-apps `AppBridge`; Claude Desktop and ChatGPT implement the same
host protocol)" instead of "inside Claude Desktop and ChatGPT". The terminal-client criterion is
unchanged.

## Consequences

- The widget acceptance criteria are proved by an automated script and can be re-run.
- Known gap: the Phase 7 widgets themselves (exclusion, submit and the result view with these
  bundles) have not been observed in Claude Desktop or ChatGPT. Client-specific differences, such
  as how a host sizes the iframe, which theme variables it sends, or whether it supports
  `openLink`, would show up only there. The checks in the real clients stay optional;
  `phase-7.sh --manual-config` keeps writing their configuration. A failure found there is
  handled as a defect.
- The install check in a real client that Phase 10 requires is not changed by this decision.

## Verified

- 2026-11-18: `bash scripts/acceptance/phase-7.sh` passed on `main`, with the `host-*` and
  `reconfigure-allow-widget` checks listed above.
- Supporting evidence from real clients: a Phase 0 manual check ([ADR 0005](0005-mcp-apps-widgets-and-fallback.md)) observed an
  ext-apps widget, its tool callback and the theme in Claude and in ChatGPT on 2026-11-16.
