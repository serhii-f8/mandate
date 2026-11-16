#!/usr/bin/env node
// Records the vendored spec and the contract-test responses from a Magento sandbox
// (NFR-17 first cut, design part 1 §6). Needs MAGENTO_SANDBOX_URL (e.g. http://127.0.0.1:4390)
// and MAGENTO_SANDBOX_TOKEN (bash deploy/sandbox/magento/token.sh).
//   pnpm --filter @aiops/magento2-catalog record
// Writes spec/magento2-catalog.swagger.json and test/recordings/<case>.json. The requests are
// the hand-written ones of test/cases.json, independent of preset.yaml, so the contract test
// checks the preset against them. Recordings hold method, path, query and the response only:
// no request header (no Authorization) is ever written, and the token is never printed.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = (process.env.MAGENTO_SANDBOX_URL ?? '').replace(/\/+$/, '');
const token = (process.env.MAGENTO_SANDBOX_TOKEN ?? '').trim();
if (baseUrl === '' || token === '') {
  console.error('set MAGENTO_SANDBOX_URL and MAGENTO_SANDBOX_TOKEN');
  process.exit(2);
}
const rest = `${baseUrl}/rest/all`;

async function get(pathAndQuery) {
  const res = await fetch(`${rest}${pathAndQuery}`, { headers: { accept: 'application/json', authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`GET ${pathAndQuery.split('?')[0]}: HTTP ${res.status}, not JSON`);
  }
  return { status: res.status, body };
}

/** Fails loudly instead of committing anything that looks like a credential. */
function assertNoToken(text, what) {
  if (text.includes(token) || text.includes('eyJ')) throw new Error(`${what} contains a token-like value; not written`);
}

async function main() {
  const spec = await get('/schema?services=catalogProductRepositoryV1');
  if (spec.status !== 200) throw new Error(`schema: HTTP ${spec.status}`);
  const specText = `${JSON.stringify(spec.body, null, 2)}\n`;
  assertNoToken(specText, 'spec');
  await mkdir(join(root, 'spec'), { recursive: true });
  await writeFile(join(root, 'spec', 'magento2-catalog.swagger.json'), specText);
  console.log('spec/magento2-catalog.swagger.json written');

  const cases = JSON.parse(await readFile(join(root, 'test', 'cases.json'), 'utf8'));
  await mkdir(join(root, 'test', 'recordings'), { recursive: true });
  for (const c of cases) {
    const query = new URLSearchParams(c.request.query).toString();
    const response = await get(`${c.request.path}?${query}`);
    const recording = { request: c.request, response };
    const text = `${JSON.stringify(recording, null, 2)}\n`;
    assertNoToken(text, `recording ${c.name}`);
    await writeFile(join(root, 'test', 'recordings', `${c.name}.json`), text);
    console.log(`test/recordings/${c.name}.json written (HTTP ${response.status})`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'record failed');
  process.exit(1);
});
