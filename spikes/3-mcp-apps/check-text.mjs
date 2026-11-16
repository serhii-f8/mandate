// Plain MCP client WITHOUT the MCP Apps capability (what a terminal client or
// any non-Apps host sees). Prints one PASS/FAIL line per assertion.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const SERVER = process.env.SERVER_URL ?? "http://localhost:4121/mcp";
const EXPECTED_URL = "http://localhost:4121/changesets/demo";
let failed = 0;
const result = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
};

// Record what goes on the wire so the protocol revision is read from the
// request headers, not assumed.
const wire = [];
const recordingFetch = async (url, init) => {
  const h = new Headers(init?.headers);
  wire.push({ method: init?.method, protocolHeader: h.get("mcp-protocol-version"), body: init?.body ? String(init.body) : "" });
  return fetch(url, init);
};

await fetch(SERVER.replace(/\/mcp$/, "/debug/reset"), { method: "POST" });

const client = new Client(
  { name: "spike3-text-client", version: "0.0.0" },
  { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
await client.connect(new StreamableHTTPClientTransport(new URL(SERVER), { fetch: recordingFetch }));

const res = await client.callTool({ name: "preview_changeset", arguments: {} });
const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
console.log(`# preview_changeset text: ${JSON.stringify(text)}`);

result("text-summary-present", /updates the price of 3 products/.test(text) && res.isError !== true, text.slice(0, 80));

const urls = text.match(/https?:\/\/[^\s)]+/g) ?? [];
result("fallback-url-present", urls.includes(EXPECTED_URL), `urls=${JSON.stringify(urls)}`);

let pageOk = false;
let pageDetail = "no url";
if (urls.includes(EXPECTED_URL)) {
  const r = await fetch(EXPECTED_URL);
  const body = await r.text();
  const ctype = r.headers.get("content-type") ?? "";
  // The page bundle must contain the shared component (its test id) — the
  // rendered check is page-renders-same-component in check-host.mjs.
  pageOk = r.status === 200 && ctype.startsWith("text/html") && body.includes('id="root"') && body.includes("changeset-view");
  pageDetail = `status=${r.status} type=${ctype} bytes=${body.length}`;
}
result("fallback-url-serves-page", pageOk, pageDetail);

// --- supporting assertions -------------------------------------------------------
const tools = await client.listTools();
const preview = tools.tools.find((t) => t.name === "preview_changeset");
const uri = preview?._meta?.ui?.resourceUri;
let mime = null;
if (uri) {
  const rr = await client.readResource({ uri });
  mime = rr.contents?.[0]?.mimeType ?? null;
}
result(
  "tool-links-ui-resource",
  uri === "ui://changeset/preview.html" && preview?._meta?.["ui/resourceUri"] === uri && mime === "text/html;profile=mcp-app",
  `_meta.ui.resourceUri=${uri} legacy=${preview?._meta?.["ui/resourceUri"]} mimeType=${mime}`,
);

const headers = [...new Set(wire.map((w) => w.protocolHeader))];
const usedInitialize = wire.some((w) => w.body.includes('"method":"initialize"'));
result(
  "wire-protocol-2026-07-28-stateless",
  headers.length === 1 && headers[0] === "2026-07-28" && !usedInitialize && client.getNegotiatedProtocolVersion() === "2026-07-28",
  `MCP-Protocol-Version headers=${JSON.stringify(headers)} initialize-sent=${usedInitialize} negotiated=${client.getNegotiatedProtocolVersion()}`,
);

const calls = await (await fetch(SERVER.replace(/\/mcp$/, "/debug/calls"))).json();
const pc = calls.find((c) => c.tool === "preview_changeset");
result("server-saw-no-ui-capability", pc && pc.uiCapable === false && pc.era === "modern", JSON.stringify(pc));

await client.close();

// 2025-era client (initialize handshake, default versionNegotiation 'legacy'):
// today's hosts may still connect this way; the same endpoint must serve it.
const wireLegacy = [];
const legacy = new Client({ name: "spike3-legacy-client", version: "0.0.0" });
await legacy.connect(
  new StreamableHTTPClientTransport(new URL(SERVER), {
    fetch: async (u, init) => {
      wireLegacy.push(init?.body ? String(init.body) : "");
      return fetch(u, init);
    },
  }),
);
const lres = await legacy.callTool({ name: "preview_changeset", arguments: {} });
const ltext = (lres.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
result(
  "legacy-2025-client-gets-same-text",
  ltext === text && wireLegacy.some((b) => b.includes('"method":"initialize"')),
  `negotiated=${legacy.getNegotiatedProtocolVersion?.()} sameText=${ltext === text}`,
);
await legacy.close();
process.exit(failed ? 1 : 0);
