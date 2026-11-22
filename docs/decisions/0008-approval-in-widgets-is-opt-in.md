# ADR 0008: Approval decisions in widgets are opt-in and limited

- Status: Accepted
- Date: 2026-11-16

## Context

[SPEC](../SPEC.md) section 2 step 7 said an approver decides "on the trusted page or in a widget".
Phase 0 spike 3 ([ADR 0005](0005-mcp-apps-widgets-and-fallback.md)) showed that a widget acts by asking the host to send
`tools/call` to the server. The server cannot tell that call from one the model makes. MCP Apps
lets a tool be declared `_meta.ui.visibility: ["app"]` so the model does not see it, but the host
enforces that, not the server. An approval tool is therefore callable by the approver's model on
any host that ignores or mishandles the visibility hint — which contradicts the design principle
"The model is not trusted … approval screens … are server code with no model in the path".

Separation of duties (APR-2) still prevents a requester's model from approving its own change-set.
The exposure is an approver's model approving someone else's change-set without the approver
clicking anything.

## Options considered

1. **Widget approval everywhere** (allow it, record the channel, let policy require the page per
   operation class). Best experience; default is the weaker channel.
2. **No approval in widgets at all.** Strongest; the approval widget becomes read-only with a
   link. Removes a stated feature of the spec.
3. **Trusted page by default; widget approval opt-in per role; never for step-up or
   `destructive`.** Default is the strong channel, the feature remains available to organisations
   that accept the risk for low-impact operations.

## Decision

Option 3. Step-up authentication (AUTH-6) cannot be performed inside a widget anyway, since it
needs a browser redirect to the identity provider. The audit records the channel (`page` or
`widget`) of every approval decision.

## Consequences

- SPEC section 2 step 7 changed with this decision. The rule is a tracked requirement, **APR-8**
  (Phase 6), SEC-8 names widget approval as its only exception, and APR-5 states that the widget
  view is also built from stored data.
- Phase 6 builds approval on the trusted page first; the role configuration gets an explicit
  `approval.allow_widget` style switch, default off (name fixed in Phase 6).
- Phase 7's approval widget shows the change-set and, unless opted in, a button that opens the
  trusted page.
- A manual check in real hosts should record whether Claude Desktop and ChatGPT keep
  `visibility: ["app"]` tools away from the model; that evidence may relax or tighten this
  decision.

## Verified

- Spike 3 `spikes/3-mcp-apps/run.sh`, assertion `widget-calls-submit-tool`: the server log shows
  the widget's call arriving as an ordinary `tools/call` from the host's connection (2026-11-16,
  `@modelcontextprotocol/ext-apps` 2.0.4).
- Whether real hosts enforce `visibility` is `unverified`. Observed on 2026-11-16 in a manual
  check: with the default visibility, Claude's model saw `submit_changeset` and offered to call it
  without the button, which is the situation this ADR guards against. A tool restricted to
  `["app"]` was not tried in a real host.
