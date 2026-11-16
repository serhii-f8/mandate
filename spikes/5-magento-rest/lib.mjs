// Shared helpers: REST client, assertions.
export const BASE = process.env.MAGENTO_URL ?? 'http://localhost:4380';
export let TOKEN = null;
export const results = [];

export function assert(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  # ' + detail : ''}`);
}

export async function login() {
  const r = await fetch(`${BASE}/rest/V1/integration/admin/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin123!spike' }),
  });
  if (!r.ok) throw new Error(`token: ${r.status} ${await r.text()}`);
  TOKEN = await r.json();
  return TOKEN;
}

export const calls = { n: 0 };
export async function api(method, path, body, { raw = false } = {}) {
  calls.n++;
  const r = await fetch(`${BASE}/rest${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (raw) return { status: r.status, text };
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitBulk(uuid, expectedOps, timeoutMs = 180000) {
  const t0 = Date.now();
  for (;;) {
    const s = await api('GET', `/V1/bulk/${uuid}/status`);
    const ops = s.json.operations_list ?? [];
    const open = ops.filter((o) => o.status === 4).length;
    if (ops.length >= expectedOps && open === 0) return { ms: Date.now() - t0, status: s.json };
    if (Date.now() - t0 > timeoutMs) throw new Error(`bulk ${uuid} timeout: ${JSON.stringify(s.json).slice(0, 400)}`);
    await sleep(1000);
  }
}
