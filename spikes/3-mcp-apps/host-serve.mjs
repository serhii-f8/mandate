// Static servers for the reference host, replacing basic-host's serve.ts
// (ext-apps v2.0.4 examples/basic-host/serve.ts, which needs bun + express):
//   :4122  host page   (dist/host/host/index.html)
//   :4123  sandbox proxy (dist/host/host/sandbox.html) on a different origin,
//          as spec 2026-01-26 "Sandbox proxy" rule 1 requires.
// CSP: basic-host's serve.ts is permissive ('unsafe-eval', connect-src 'self',
// blob:, ...). This spike instead applies the spec's restrictive default
// (spec 2026-01-26 "UI Resource Format > Host Behavior") plus the declared
// domains per "Security Implications > Content Security Policy Enforcement",
// to prove the widget works under the strictest policy a real host may use.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST_PORT = Number(process.env.HOST_PORT ?? 4122);
const SANDBOX_PORT = Number(process.env.SANDBOX_PORT ?? 4123);
const HOST_HTML = fs.readFileSync(path.join(DIR, "dist/host/host/index.html"), "utf8");
const SANDBOX_HTML = fs.readFileSync(path.join(DIR, "dist/host/host/sandbox.html"), "utf8");

const clean = (list) => (Array.isArray(list) ? list.filter((d) => typeof d === "string" && !/[;\r\n'" ]/.test(d)) : []);

function buildCsp(csp) {
  const res = clean(csp?.resourceDomains).join(" ");
  const con = clean(csp?.connectDomains).join(" ");
  const frame = clean(csp?.frameDomains).join(" ");
  const base = clean(csp?.baseUriDomains).join(" ");
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${res}`.trim(),
    `style-src 'self' 'unsafe-inline' ${res}`.trim(),
    `img-src 'self' data: ${res}`.trim(),
    `font-src 'self' ${res}`.trim(),
    `media-src 'self' data: ${res}`.trim(),
    con ? `connect-src ${con}` : "connect-src 'none'",
    frame ? `frame-src ${frame}` : "frame-src 'none'",
    "object-src 'none'",
    base ? `base-uri ${base}` : "base-uri 'self'",
  ].join("; ");
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(HOST_HTML);
    }
    res.writeHead(404).end("not found");
  })
  .listen(HOST_PORT, "127.0.0.1", () => console.log(`[host] http://localhost:${HOST_PORT}/`));

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/sandbox.html") return res.writeHead(404).end("only sandbox.html");
    let csp;
    try {
      csp = url.searchParams.has("csp") ? JSON.parse(url.searchParams.get("csp")) : undefined;
    } catch {
      csp = undefined;
    }
    const header = buildCsp(csp);
    console.log(`[sandbox] CSP: ${header}`);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": header,
      "cache-control": "no-store",
    });
    res.end(SANDBOX_HTML);
  })
  .listen(SANDBOX_PORT, "127.0.0.1", () => console.log(`[sandbox] http://localhost:${SANDBOX_PORT}/sandbox.html`));
