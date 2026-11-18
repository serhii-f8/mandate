// Reference MCP Apps host for the acceptance run (MCP-5, UI-6). Node holds the user's token,
// so widget tool calls are forwarded from here; the browser needs no token and no CORS.
//
//   AIOPS_MCP_TOKEN=T widget-host.mjs <mcp-url> list
//   AIOPS_MCP_TOKEN=T widget-host.mjs <mcp-url> render --tool NAME [--args JSON] [--exclude N]
//       [--submit] [--decide approve] [--open-page] [--wait-terminal S]
// Prints one JSON line; exit 0 whenever it is printed, 2 on usage errors.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { chromium } from 'playwright';
import { MCP_APPS_DEFAULT_CSP, parseArgs, TERMINAL } from './widget-host-lib.mjs';

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const token = process.env.AIOPS_MCP_TOKEN;
if (!token) {
  console.error('AIOPS_MCP_TOKEN is required');
  process.exit(2);
}

const authFetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
};
const client = new Client({ name: 'aiops-reference-host', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
await client.connect(new StreamableHTTPClientTransport(new URL(opts.url), { fetch: authFetch }));

if (opts.command === 'list') {
  const tools = await client.listTools();
  const resources = await client.listResources();
  await client.close();
  console.log(
    JSON.stringify({
      tools: tools.tools.map((t) => ({ name: t.name, meta: t._meta })),
      resources: resources.resources.map((r) => ({ uri: r.uri, mimeType: r.mimeType, meta: r._meta })),
    }),
  );
  process.exit(0);
}

const out = {
  tool: opts.tool, resourceUri: null, mimeType: null, csp: MCP_APPS_DEFAULT_CSP, state: null, rows: 0, buttons: [],
  calls: [], links: [], modelContext: [], bodyText: '', cspBlocked: null, themeVar: null, errors: [],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}

let browser;
let server;
try {
  const trigger = await client.callTool({ name: opts.tool, arguments: opts.args });
  const uri = trigger._meta?.ui?.resourceUri ?? (await client.listTools()).tools.find((t) => t.name === opts.tool)?._meta?.ui?.resourceUri;
  if (typeof uri !== 'string') throw new Error(`tool ${opts.tool} links no UI resource`);
  out.resourceUri = uri;
  const read = await client.readResource({ uri });
  const content = read.contents[0];
  out.mimeType = content.mimeType ?? null;
  const html = content.text ?? Buffer.from(content.blob ?? '', 'base64').toString('utf8');

  const hostPage = await readFile(fileURLToPath(new URL('./widget-host/dist/index.html', import.meta.url)), 'utf8');
  server = createServer((req, res) => {
    if (req.url === '/frame') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': MCP_APPS_DEFAULT_CSP });
      res.end(html);
    } else if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(hostPage);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const hostUrl = `http://127.0.0.1:${server.address().port}/`;

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (e) => out.errors.push(String(e.message)));
  await page.exposeFunction('aiopsTrigger', () => ({ arguments: opts.args, result: JSON.parse(JSON.stringify(trigger)) }));
  await page.exposeFunction('aiopsCallTool', async (params) => {
    const rec = { name: params.name, args: params.arguments ?? {}, isError: false, structuredContent: undefined };
    out.calls.push(rec);
    try {
      const result = await client.callTool({ name: params.name, arguments: params.arguments ?? {} });
      rec.isError = result.isError === true;
      rec.structuredContent = result.structuredContent;
      return JSON.parse(JSON.stringify(result));
    } catch (e) {
      rec.isError = true;
      out.errors.push(`callTool ${params.name}: ${e.message}`);
      throw e;
    }
  });
  await page.exposeFunction('aiopsOpenLink', (url) => void out.links.push(url));
  await page.exposeFunction('aiopsModelContext', (p) => void out.modelContext.push(p));
  await page.goto(hostUrl);
  await page.waitForFunction(() => ['initialized', 'error'].includes(window.__host?.state), null, { timeout: 20000 });
  out.state = await page.evaluate(() => window.__host.state);
  if (out.state === 'error') out.errors.push(await page.evaluate(() => window.__host.error ?? 'host error'));

  const frame = page.frameLocator('#widget');
  const frameObj = page.frame({ url: /\/frame$/ });
  const waitCall = (name, ms = 15000) => until(() => out.calls.some((c) => c.name === name), ms, `call ${name}`);
  if (out.state === 'initialized') {
    await frame.getByRole('row').first().waitFor({ timeout: 15000 }).catch((e) => out.errors.push(`no rows: ${e.message}`));
    const countRows = async () => (await frame.getByRole('row').count()) - (await frame.locator('thead').getByRole('row').count());
    out.rows = await countRows();
    const doStep = async (label, fn) => {
      try {
        await fn();
      } catch (e) {
        out.errors.push(`${label}: ${e.message}`);
      }
    };
    if (opts.exclude) {
      await doStep('exclude', async () => {
        const boxes = frame.getByRole('checkbox');
        let ticked = 0;
        for (let i = 0; i < (await boxes.count()) && ticked < opts.exclude; i++) {
          if (await boxes.nth(i).isEnabled()) {
            await boxes.nth(i).check();
            ticked++;
          }
        }
        await frame.getByRole('button', { name: /^Exclude selected/ }).click();
        await waitCall('exclude_changeset_items');
      });
    }
    if (opts.submit) {
      await doStep('submit', async () => {
        await frame.getByRole('button', { name: /^Submit \d+ change/ }).click();
        await waitCall('submit_for_approval');
      });
    }
    if (opts.decide) {
      await doStep('decide', async () => {
        await frame.getByRole('button', { name: /^Approve \d+ change/ }).click();
        await waitCall('decide_changeset');
      });
    }
    if (opts.openPage) {
      await doStep('open-page', async () => {
        await frame.getByRole('button', { name: 'Decide on the approval page' }).or(frame.getByRole('link', { name: 'Decide on the approval page' })).first().click();
        await until(() => out.links.length >= 1, 10000, 'openLink');
      });
    }
    if (opts.waitTerminal !== undefined) {
      await doStep('wait-terminal', async () => {
        const statusOf = (r) => r?.structuredContent?.status ?? r?.structuredContent?.changeset?.status;
        await until(() => {
          const last = [...out.calls].reverse().find((c) => c.name === 'get_changeset');
          return TERMINAL.has(statusOf(last) ?? statusOf({ structuredContent: trigger.structuredContent }));
        }, opts.waitTerminal * 1000, 'terminal status');
        await sleep(500);
      });
    }
    out.bodyText = await frame.locator('body').innerText().catch(() => '');
    out.buttons = (await frame.getByRole('button').allInnerTexts().catch(() => [])).map((t) => t.trim()).filter(Boolean);

    const origin = new URL(opts.url).origin;
    out.cspBlocked = await frameObj.evaluate(async (u) => {
      const violations = [];
      const onV = (e) => violations.push(e.effectiveDirective);
      document.addEventListener('securitypolicyviolation', onV);
      let failed = false;
      try {
        await fetch(u);
      } catch {
        failed = true;
      }
      await new Promise((r) => setTimeout(r, 200));
      document.removeEventListener('securitypolicyviolation', onV);
      return failed && violations.some((v) => v.startsWith('connect-src'));
    }, `${origin}/healthz`);
    out.themeVar = await frameObj.evaluate(() => document.documentElement.style.getPropertyValue('--color-background-primary'));
  }
} catch (e) {
  out.errors.push(String(e.message ?? e));
} finally {
  await browser?.close();
  server?.close();
  await client.close().catch(() => {});
}
console.log(JSON.stringify(out));
process.exit(0);
