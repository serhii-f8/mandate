// Headless Chromium drives the reference host (ext-apps basic-host core,
// vendored in host/vendor) which renders the widget in the double-iframe
// sandbox and forwards the widget's tools/call to the MCP server.
// Prints one PASS/FAIL line per assertion.
import { chromium } from "playwright";

const HOST = process.env.HOST_URL ?? "http://localhost:4122/";
const SERVER = process.env.SERVER_URL ?? "http://localhost:4121/mcp";
const BASE = SERVER.replace(/\/mcp$/, "");
const PAGE_URL = "http://localhost:4121/changesets/demo";
const HOST_DARK_BG = "rgb(26, 26, 26)"; // basic-host --color-background-primary dark value (#1a1a1a)
const HOST_LIGHT_BG = "rgb(255, 255, 255)"; // light value (#ffffff)

let failed = 0;
const result = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
};
const getCalls = async () => (await fetch(`${BASE}/debug/calls`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, timeoutMs = 10000, every = 100) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  return last;
}

await fetch(`${BASE}/debug/reset`, { method: "POST" });

const consoleLines = [];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ colorScheme: "dark" });
  const page = await context.newPage();
  page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));

  await page.goto(`${HOST}?server=${encodeURIComponent(SERVER)}`);
  await page.waitForFunction(() => ["app-initialized", "error", "no-ui"].includes(window.__host?.state), null, {
    timeout: 20000,
  });
  const hostState = await page.evaluate(() => ({ state: window.__host.state, error: window.__host.error }));
  console.log(`# host state: ${JSON.stringify(hostState)}`);

  // Locate outer (sandbox proxy) and inner (view) frames.
  const outerEl = await page.$("#app-frame");
  const outer = outerEl ? await outerEl.contentFrame() : null;
  const innerEl = outer ? await outer.waitForSelector("iframe", { timeout: 5000 }).catch(() => null) : null;
  const inner = innerEl ? await innerEl.contentFrame() : null;
  const sandboxInfo = {
    outerSandbox: outerEl ? await outerEl.getAttribute("sandbox") : null,
    outerOrigin: outer ? new URL(outer.url()).origin : null,
    hostOrigin: new URL(page.url()).origin,
    innerSandbox: innerEl ? await innerEl.getAttribute("sandbox") : null,
  };

  // 1. widget-renders-summary
  let summary = "";
  let rows = 0;
  if (inner) {
    summary = await inner
      .waitForSelector('[data-testid="changeset-summary"]', { timeout: 10000 })
      .then((el) => el.textContent())
      .catch(() => "");
    rows = await inner.locator("tbody tr").count();
  }
  const sandboxed =
    !!sandboxInfo.outerSandbox &&
    !!sandboxInfo.innerSandbox &&
    sandboxInfo.outerOrigin !== sandboxInfo.hostOrigin &&
    !sandboxInfo.outerSandbox.includes("allow-top-navigation");
  result(
    "widget-renders-summary",
    hostState.state === "app-initialized" && /updates the price of 3 products/.test(summary) && rows === 3 && sandboxed,
    `summary=${JSON.stringify(summary.slice(0, 60))} rows=${rows} sandbox=${JSON.stringify(sandboxInfo)}`,
  );

  // 2. widget-applies-host-theme (initial dark from host context, then a live
  //    host-context-changed to light)
  let themeDetail = "no inner frame";
  let themeOk = false;
  if (inner) {
    const read = () =>
      inner.evaluate(() => ({
        dataTheme: document.documentElement.getAttribute("data-theme"),
        colorScheme: document.documentElement.style.colorScheme,
        hostVar: document.documentElement.style.getPropertyValue("--color-background-primary"),
        bg: getComputedStyle(document.querySelector(".cs")).backgroundColor,
      }));
    const dark = await read();
    await page.evaluate(() => window.__host.setTheme("light"));
    const light = await poll(async () => {
      const s = await read();
      return s.dataTheme === "light" && s.bg === HOST_LIGHT_BG ? s : null;
    }, 5000).then((s) => s ?? read());
    themeOk =
      dark.dataTheme === "dark" &&
      dark.bg === HOST_DARK_BG &&
      dark.hostVar.includes("light-dark(") &&
      light.dataTheme === "light" &&
      light.bg === HOST_LIGHT_BG;
    themeDetail = `dark=${JSON.stringify(dark)} afterToggle=${JSON.stringify(light)}`;
  }
  result("widget-applies-host-theme", themeOk, themeDetail);

  // 3. widget-calls-submit-tool (negative control: no submit before the click)
  const before = (await getCalls()).filter((c) => c.tool === "submit_changeset").length;
  let call = null;
  if (inner) {
    await inner.click('[data-testid="submit-button"]', { timeout: 5000 }).catch((e) => consoleLines.push(`[click] ${e.message}`));
    call = await poll(async () => (await getCalls()).find((c) => c.tool === "submit_changeset") ?? null, 10000);
  }
  result(
    "widget-calls-submit-tool",
    before === 0 && !!call && call.changesetId === "demo" && call.uiCapable === true && call.era === "modern",
    `submitCallsBeforeClick=${before} serverRecorded=${JSON.stringify(call)}`,
  );

  // 4. widget-shows-submit-result
  let shown = "";
  if (inner) {
    shown = await poll(async () => {
      const t = await inner.locator('[data-testid="submit-result"]').textContent({ timeout: 500 }).catch(() => "");
      return t === "submitted:demo" ? t : null;
    }, 10000).then((t) => t ?? inner.locator('[data-testid="submit-result"]').textContent({ timeout: 500 }).catch(() => ""));
  }
  result("widget-shows-submit-result", shown === "submitted:demo", `text=${JSON.stringify(shown)}`);

  // Supporting: the sandboxed widget has no direct network path to the server
  // (spec default CSP connect-src 'none'), so callbacks must go through the host.
  let netDetail = "no inner frame";
  let netBlocked = false;
  if (inner) {
    // Distinguish a CSP block from a CORS failure: require a
    // securitypolicyviolation event for connect-src.
    const r = await inner.evaluate(async (u) => {
      const violations = [];
      const onV = (e) => violations.push(`${e.effectiveDirective} blocked ${e.blockedURI}`);
      document.addEventListener("securitypolicyviolation", onV);
      let outcome;
      try {
        const res = await fetch(u);
        outcome = `fetched status=${res.status}`;
      } catch (e) {
        outcome = `failed: ${e.name}: ${e.message}`;
      }
      await new Promise((r) => setTimeout(r, 200));
      document.removeEventListener("securitypolicyviolation", onV);
      return { outcome, violations };
    }, `${BASE}/healthz`);
    netBlocked = r.outcome.startsWith("failed") && r.violations.some((v) => v.startsWith("connect-src"));
    netDetail = JSON.stringify(r);
  }
  result("widget-network-blocked-by-csp", netBlocked, netDetail);

  // Supporting (UI-1): the fallback page renders the same component standalone.
  const p2 = await context.newPage();
  p2.on("console", (m) => consoleLines.push(`[page:${m.type()}] ${m.text()}`));
  await p2.goto(PAGE_URL);
  const pageSummary = await p2
    .waitForSelector('[data-testid="changeset-summary"]', { timeout: 10000 })
    .then((el) => el.textContent())
    .catch(() => "");
  const pageMode = await p2.locator('[data-testid="changeset-view"]').getAttribute("data-mode").catch(() => null);
  // Negative control for widget-applies-host-theme: without a host the same
  // CSS resolves to its own fallback (#002b36 in dark), not the host colour.
  const pageBg = await p2.evaluate(() => getComputedStyle(document.querySelector(".cs")).backgroundColor).catch(() => null);
  await p2.click('[data-testid="submit-button"]').catch(() => {});
  const pageResult = await poll(async () => {
    const t = await p2.locator('[data-testid="submit-result"]').textContent({ timeout: 500 }).catch(() => "");
    return t === "submitted:demo" ? t : null;
  }, 5000);
  result(
    "page-renders-same-component",
    pageSummary === summary && pageMode === "page" && pageResult === "submitted:demo" && pageBg === "rgb(0, 43, 54)",
    `summaryEqualsWidget=${pageSummary === summary} mode=${pageMode} submit=${pageResult} fallbackBg=${pageBg}`,
  );
} catch (e) {
  failed++;
  console.log(`FAIL check-host-crashed -- ${e?.stack ?? e}`);
} finally {
  await browser?.close();
}

if (failed) {
  console.log("# browser console (last 60 lines):");
  for (const l of consoleLines.slice(-60)) console.log(`#   ${l.slice(0, 300)}`);
}
process.exit(failed ? 1 : 0);
