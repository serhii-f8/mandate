# Spike 3 — MCP Apps

Throwaway experiment for Phase 0 (open item 4; de-risks MCP-5, MCP-6, UI-1, UI-6).

## What is here

| Path | Role |
| --- | --- |
| `server.mjs` | MCP server on :4121 (`@modelcontextprotocol/server@2.4.0` `createMcpHandler`, stateless 2026-07-28 plus 2025 stateless fallback). Tools `preview_changeset`, `submit_changeset`; UI resource `ui://changeset/preview.html`; page `GET /changesets/:id`; REST for the page; `/debug/calls` instrumentation. |
| `src/ChangesetView.tsx` | The one React view component (UI-1). |
| `src/widget.tsx` | Widget entry: view + `@modelcontextprotocol/ext-apps@2.0.4` `useApp` / `useHostStyles` / `callServerTool`. |
| `src/page.tsx` | Page entry: view + REST API. |
| `vite.config.mjs` | Single-file builds (`vite-plugin-singlefile`) for widget, page, host and sandbox. |
| `host/vendor/*` | ext-apps v2.0.4 `examples/basic-host` code (vendored; patches marked `SPIKE:`). |
| `host/main.ts`, `host/index.html` | Replaces only basic-host's React shell with a scripted flow. |
| `host-serve.mjs` | Host page on :4122, sandbox proxy on :4123 (separate origin) with the spec's restrictive CSP. |
| `check-text.mjs` | Plain MCP client without Apps capability (text + fallback URL). |
| `check-host.mjs` | Playwright Chromium drives the reference host (widget render, tool callback, theme). |
| `run.sh` | Clean build, start, both checks, stop. |

## Prerequisites

- Node v22.20.0, npm (not pnpm).
- `npm ci` (run.sh does it when `node_modules` is missing).
- Chromium for Playwright 1.65.1: `npx playwright install chromium` (revision 1255).
- Free ports 4121, 4122, 4123 (run.sh kills leftovers on them).

## Run

```bash
./run.sh          # or: npm run check
```

Prints one `PASS`/`FAIL` line per assertion and exits non-zero on any failure.

## Run manually (for the client checks in the finding's "Manual steps")

```bash
npm run build
PUBLIC_BASE_URL=https://<your-tunnel-host> node server.mjs   # MCP at /mcp, page at /changesets/demo
node host-serve.mjs                                          # optional local reference host on :4122
```

## Tear down

`run.sh` stops its processes on exit. If something was started by hand:
`lsof -t -iTCP:4121 -iTCP:4122 -iTCP:4123 -sTCP:LISTEN | xargs -r kill`.
No Docker containers are used. `rm -rf node_modules dist .run` removes all generated files.
