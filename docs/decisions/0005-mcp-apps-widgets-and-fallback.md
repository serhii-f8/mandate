# ADR 0005: MCP Apps widgets and the text + URL fallback

- Status: Accepted
- Date: 2026-11-16

## Context

[SPEC](../SPEC.md) requires views delivered as MCP Apps widgets (MCP-5) that are the same React
components as the trusted pages (UI-1), call back only to platform tools and adopt the host theme
(UI-6), and a text summary plus fallback HTTPS URL for clients without widget support (MCP-4,
MCP-6). Phase 0 spike 3 built a server, a widget, a page and a reference host on
`@modelcontextprotocol/ext-apps` 2.0.4 and `@modelcontextprotocol/server`/`client` 2.4.0, and
passed all automated checks. Facts that drive the decision:

- The MCP Apps spec (2026-01-26, Stable) links a UI to a **tool definition**
  (`_meta.ui.resourceUri`); embedding resources or links in results was deferred.
- Hosts render the HTML in sandboxed iframes; web hosts use a sandbox proxy on another origin.
  Default CSP is `default-src 'none'`, inline script/style only, `connect-src 'none'`.
- The View talks to the host only by JSON-RPC over `postMessage`; `tools/call` from the View is
  forwarded by the host on its own MCP connection. The server cannot tell a View call from a model
  call.
- A host without Apps support treats the tool as an ordinary tool; the spec requires a meaningful
  `content` array regardless.
- ext-apps 2.x requires the split SDK packages (`@modelcontextprotocol/core|client|server`
  ^2.0.0), not `@modelcontextprotocol/sdk` 1.x.

## Options considered

| Question | Options | Decision |
| --- | --- | --- |
| Declare and link UI | (a) resource + `_meta.ui.resourceUri` on the tool; (b) embedded resource or resource link in the result | **(a)**, via `registerAppResource` / `registerAppTool` (which also writes the deprecated `_meta["ui/resourceUri"]` for older hosts) |
| Vary by client capability | (a) same tools and results for everyone; (b) register UI variants only when the client declares `io.modelcontextprotocol/ui` | **(a)** |
| Bundle format | (a) single-file HTML (inlined JS/CSS); (b) HTML loading assets from our origin via `resourceDomains` | **(a)**, Vite + `vite-plugin-singlefile` |
| Same component as widget and page | (a) prop-only component + two entries (widget, page); (b) one bundle with runtime host detection | **(a)** |
| Widget → platform | (a) `app.callServerTool` → host → MCP server; (b) widget fetches REST API (`connectDomains`, `ui.domain`, own auth) | **(a)** |
| Theme | (a) standard host CSS variables via `useHostStyles`, own fallbacks; (b) own theme only | **(a)** |
| Fallback delivery | (a) URL inside the text `content` of every widget tool's result; (b) only for clients without the capability; (c) separate `resource_link` block | **(a)** |

## Decision

1. **Declaration.** One UI resource per view: URI `ui://<view>/<name>.html`, MIME
   `text/html;profile=mcp-app`, content = the full HTML document in `text`, resource
   `_meta.ui = { csp: {}, prefersBorder: true }`. Each tool that shows a view sets
   `_meta.ui.resourceUri` to it. Registration uses `registerAppResource` and `registerAppTool` from
   `@modelcontextprotocol/ext-apps/server`.
2. **Results.** Every result of such a tool has `content` = one short text summary that ends with
   the fallback URL to the trusted page, and `structuredContent` = the view's data. Results and
   tool lists do not depend on the client's declared capabilities.
3. **Bundle and dual build (UI-1).** Views in `packages/widgets` are React components that receive
   data and actions as props and import nothing from MCP. Each view has a widget entry (`useApp`,
   `useHostStyles`, `ontoolresult`, `callServerTool` from `@modelcontextprotocol/ext-apps/react`)
   built by Vite with `vite-plugin-singlefile` into one HTML file that `api` serves as the
   resource, and a page entry in `web` that reads and writes via the REST API.
4. **Callbacks (UI-6).** Widgets act only through `app.callServerTool` on the platform's own
   tools; the host forwards on the user's authenticated MCP connection. Widgets make no network
   requests (empty `csp`), use no `localStorage`, and load no external assets. Every tool call is
   authorized server-side as if the model had made it; UI-only helper tools use
   `_meta.ui.visibility: ["app"]`, and tools the model also needs (e.g. submit) keep the default
   `["model","app"]`.
5. **Theme.** Widget CSS uses the standard MCP Apps variables (`--color-*`, `--font-*`,
   `--border-radius-*`) with our own fallbacks; `useHostStyles` applies the host's variables and
   `color-scheme`, and follows `host-context-changed`.
6. **Fallback (MCP-4, MCP-6).** The fallback URL is built from a configured public HTTPS base of
   `web` and appears in the result text for every client; the widget also offers it as an "Open as
   page" link.
7. **Endpoint.** The MCP endpoint is `createMcpHandler` with a per-request server factory
   (2026-07-28 stateless, 2025 stateless fallback), so Apps hosts on either era work.

## Consequences

- Clients without Apps support (Claude Code, terminal clients) get a useful text answer and a link
  with no extra code path; Apps hosts get the widget from the same result.
- Approval or other sensitive actions taken in a widget are only as trustworthy as the host: the
  server sees an ordinary `tools/call` from the user's connection. Hiding `visibility: ["app"]`
  tools from the model is host-enforced. The audit should record the channel, and policy may
  require the trusted page for some operation classes (a SPEC change to that effect was proposed;
  see the addendum).
- Widget bundles carry React, ext-apps and zod (≈450 KB single file in the spike); the shared
  component library must stay small and dependency-light.
- Data a widget needs beyond the triggering result requires extra tools; there is no direct API
  access from widgets.
- `api` depends on `@modelcontextprotocol/server` 2.x; this matches the SDK choice of
  [ADR 0003](0003-mcp-sdk-and-transport.md).
- CSP/sandbox constraints that bind the design: single HTML document; inline script and style
  only; `connect-src 'none'`; `frame-src 'none'` (no embedding our pages inside a widget without
  `frameDomains`, which ChatGPT blocks by default); `ui.domain` formats are host-specific (Claude:
  `<sha256(serverUrl)[0:32]>.claudemcpcontent.com`) and not needed while widgets make no requests;
  the widget must work without `unsafe-eval` (ext-apps sets zod jitless by default).
- Revisit if a later ext-apps version (2.1.0 already published) changes linkage or adds
  result-level resources.

## Verified

- Automated, 2026-11-16, `spikes/3-mcp-apps/run.sh` (exit 0, 13 PASS): text summary and fallback
  URL for a client without the Apps capability on 2026-07-28 and on a 2025 client; tool → resource
  linkage and MIME; widget rendered in the ext-apps basic-host double-iframe sandbox in headless
  Chromium under the spec's restrictive CSP; widget's `submit_changeset` call recorded by the
  server as coming from the host's connection; result shown in the widget; host theme applied and
  live-switched; direct `fetch` from the widget blocked by `connect-src`; page renders the same
  component.
- Documents, 2026-11-16: `@modelcontextprotocol/ext-apps@2.0.4` `package.json`,
  `dist/src/server/index.d.ts`, `dist/src/react/*.d.ts`, `dist/src/app.d.ts`; ext-apps repo tag
  v2.0.4 `specification/2026-01-26/apps.mdx`, `examples/basic-host`, `examples/basic-server-react`;
  `@modelcontextprotocol/server@2.4.0` and `client@2.4.0` typings;
  claude.com/docs/connectors/building/mcp-apps/getting-started;
  support.claude.com/en/articles/13454812; code.claude.com/docs/en/mcp;
  developers.openai.com/apps-sdk/mcp-apps-in-chatgpt/;
  code.visualstudio.com/blogs/2026/01/26/mcp-apps-support.
- Not verified by the automated run: rendering in Claude Desktop, claude.ai and ChatGPT
  (documentation only).
- Manual check, 2026-11-16: the widget and its Submit call were observed in Claude and ChatGPT.

## Addendum 2026-11-16: approval in widgets

The SPEC change proposed above (record the channel; let policy require the trusted page for some
operation classes) was not applied as proposed. It is superseded by [ADR 0008](0008-approval-in-widgets-is-opt-in.md) and
requirement APR-8: approval in a widget is opt-in per role and excluded for step-up and
`destructive` operations.
