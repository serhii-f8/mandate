// Spike 3 MCP server on :4121.
//  POST /mcp                       MCP endpoint (createMcpHandler: 2026-07-28 stateless,
//                                  2025-era stateless fallback) from @modelcontextprotocol/server@2.4.0
//  GET  /changesets/:id            standalone page (same React component as the widget)
//  GET  /api/changesets/:id        change-set JSON for the page
//  POST /api/changesets/:id/submit page's submit (same domain function as the tool)
//  GET  /debug/calls, POST /debug/reset   test instrumentation: which tools were called, by whom
//
// UI linkage per ext-apps@2.0.4 dist/src/server/index.d.ts (registerAppTool /
// registerAppResource) and spec 2026-01-26 "UI Resource Format" / "Resource Discovery".
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
  getUiCapability,
} from "@modelcontextprotocol/ext-apps/server";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4121);
// Fallback URL base. SPEC MCP-6 wants HTTPS; this spike serves plain HTTP on
// localhost, so the base is http://localhost:4121 unless PUBLIC_BASE_URL is set
// (e.g. to an HTTPS tunnel URL for the manual Claude/ChatGPT check).
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const HOST_ORIGIN = process.env.HOST_ORIGIN ?? "http://localhost:4122";
const RESOURCE_URI = "ui://changeset/preview.html";

const WIDGET_HTML = fs.readFileSync(path.join(DIR, "dist/widget/widget.html"), "utf8");
const PAGE_HTML = fs.readFileSync(path.join(DIR, "dist/page/page.html"), "utf8");

// --- domain (stand-in for the change-set store) -----------------------------
const CHANGESETS = {
  demo: {
    changesetId: "demo",
    title: "Change-set demo: 3 price updates",
    summary: "Change-set demo updates the price of 3 products (SKU-1, SKU-2, SKU-3) in catalog main.",
    items: [
      { sku: "SKU-1", field: "price", before: "10.00", after: "12.00" },
      { sku: "SKU-2", field: "price", before: "15.00", after: "14.50" },
      { sku: "SKU-3", field: "price", before: "99.00", after: "89.00" },
    ],
  },
};
const fallbackUrl = (id) => `${PUBLIC_BASE_URL}/changesets/${id}`;
const getChangeset = (id) => (CHANGESETS[id] ? { ...CHANGESETS[id], fallbackUrl: fallbackUrl(id) } : null);
const submitChangeset = (id) => (CHANGESETS[id] ? `submitted:${id}` : null);

// --- instrumentation -----------------------------------------------------------
let calls = [];
function record(tool, server, extra) {
  const caps = server.server.getClientCapabilities?.();
  const ui = getUiCapability(caps);
  calls.push({
    tool,
    at: new Date().toISOString(),
    client: server.server.getClientVersion?.()?.name ?? null,
    uiCapable: !!ui?.mimeTypes?.includes(RESOURCE_MIME_TYPE),
    ...extra,
  });
}

// --- MCP server factory (one instance per request: stateless) ---------------------
function createServer(ctx) {
  const server = new McpServer({ name: "fde-spike-3-mcp-apps", version: "0.0.0" });

  registerAppTool(
    server,
    "preview_changeset",
    {
      title: "Preview change-set",
      description:
        "Show the demo change-set: a text summary, a link to the change-set page, and an interactive preview widget where supported.",
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async () => {
      record("preview_changeset", server, { era: ctx?.era });
      const cs = getChangeset("demo");
      return {
        // MCP-4 / MCP-6: text summary + fallback URL for clients without Apps.
        content: [
          {
            type: "text",
            text: `${cs.summary} Review and submit: ${cs.fallbackUrl}`,
          },
        ],
        // Data for the widget (not added to model context, spec "Data Passing").
        structuredContent: cs,
      };
    },
  );

  // Default visibility ["model","app"]: callable by the model (text-only
  // clients need it, and Claude Code hides tools without "model") and by the widget.
  registerAppTool(
    server,
    "submit_changeset",
    {
      title: "Submit change-set",
      description: "Submit a previewed change-set for approval.",
      inputSchema: z.object({ changesetId: z.string() }),
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ changesetId }) => {
      record("submit_changeset", server, { era: ctx?.era, changesetId });
      const r = submitChangeset(changesetId);
      if (!r) return { isError: true, content: [{ type: "text", text: `unknown change-set ${changesetId}` }] };
      return { content: [{ type: "text", text: r }] };
    },
  );

  registerAppResource(
    server,
    "Change-set preview",
    RESOURCE_URI,
    { description: "Interactive change-set preview", mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: WIDGET_HTML,
          // No external origins: everything is inlined and data/calls go through
          // the host, so the spec's restrictive default CSP is sufficient.
          _meta: { ui: { csp: {}, prefersBorder: true } },
        },
      ],
    }),
  );

  return server;
}

const mcp = createMcpHandler(createServer, {
  onerror: (e) => console.error("[mcp] error:", e?.message ?? e),
});

// --- node:http <-> fetch bridge ---------------------------------------------------
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && origin === HOST_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] ?? "*");
    res.setHeader("Access-Control-Expose-Headers", "*");
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function handleMcp(req, res) {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v != null) headers.set(k, v);
  }
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers,
    body,
  });
  const response = await mcp.fetch(request);
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  if (!response.body) return res.end();
  const reader = response.body.getReader();
  req.on("close", () => reader.cancel().catch(() => {}));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const httpServer = http.createServer(async (req, res) => {
  try {
    cors(req, res);
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const url = new URL(req.url, "http://x");
    let m;
    if (url.pathname === "/mcp") return await handleMcp(req, res);
    if (req.method === "GET" && (m = url.pathname.match(/^\/changesets\/([\w-]+)$/))) {
      if (!CHANGESETS[m[1]]) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PAGE_HTML);
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/changesets\/([\w-]+)$/))) {
      const cs = getChangeset(m[1]);
      return cs ? json(res, 200, cs) : json(res, 404, { error: "not found" });
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/api\/changesets\/([\w-]+)\/submit$/))) {
      const r = submitChangeset(m[1]);
      calls.push({ tool: "rest:submit", at: new Date().toISOString(), changesetId: m[1] });
      return r ? json(res, 200, { result: r }) : json(res, 404, { error: "not found" });
    }
    if (req.method === "GET" && url.pathname === "/debug/calls") return json(res, 200, calls);
    if (req.method === "POST" && url.pathname === "/debug/reset") {
      calls = [];
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/healthz") return json(res, 200, { ok: true });
    json(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[http]", e);
    if (!res.headersSent) json(res, 500, { error: String(e) });
    else res.end();
  }
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`[server] MCP http://localhost:${PORT}/mcp  page ${fallbackUrl("demo")}`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => httpServer.close(() => process.exit(0)));
