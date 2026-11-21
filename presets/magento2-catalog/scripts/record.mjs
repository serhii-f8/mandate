#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
// Records the vendored spec and the contract-test responses from a Magento sandbox
// (NFR-17 first cut, design part 1 §6). Needs MAGENTO_SANDBOX_URL (e.g. http://127.0.0.1:4390)
// and MAGENTO_SANDBOX_TOKEN (bash deploy/sandbox/magento/token.sh).
//   pnpm --filter @aiops/magento2-catalog record
// Writes spec/magento2-catalog.swagger.json and test/recordings/<case>.json. The requests are
// the hand-written ones of test/cases.json, independent of preset.yaml, so the contract test
// checks the preset against them. Then it runs the write cases of test/write-cases.json
// (Phase 5, OPS-6): each POSTs an async bulk request, polls its detailed status until no
// operation is open (status 4) and reads the products back, into test/recordings/write/<case>.json.
// The write cases change only GLOBEX products (meta_keyword, plus one url_key attempt that the
// sandbox rejects), so the ACME data of the Phase 3/4 acceptance stays intact (ADR 0028). They
// need the async.operations.all consumer (bash deploy/sandbox/magento/up.sh starts it). Recordings hold method, path, query and the response only:
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

async function call(method, pathAndQuery, json) {
  const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
  const init = json === undefined ? { method, headers } : { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(json) };
  const res = await fetch(`${rest}${pathAndQuery}`, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${pathAndQuery.split('?')[0]}: HTTP ${res.status}, not JSON`);
  }
  return { status: res.status, body };
}

const get = (pathAndQuery) => call('GET', pathAndQuery);

const POLL_MS = 1000;
const POLL_LIMIT_MS = 120_000;
const OPEN = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls the detailed status until every submitted operation has left status 4 (open). */
async function pollUntilClosed(c, uuid) {
  const path = c.status.path.replace('{batch_id}', encodeURIComponent(uuid));
  const polls = [];
  const deadline = Date.now() + POLL_LIMIT_MS;
  for (;;) {
    await sleep(POLL_MS);
    const poll = await get(path);
    polls.push(poll);
    const ops = poll.status === 200 && Array.isArray(poll.body?.operations_list) ? poll.body.operations_list : [];
    if (ops.length >= c.records.length && ops.every((op) => op.status !== OPEN)) return { polls, ops };
    if (Date.now() >= deadline) {
      throw new Error('bulk still open after 120 s: is the async.operations.all consumer running? (bash deploy/sandbox/magento/up.sh starts it)');
    }
  }
}

async function recordWrite(c) {
  const response = await call(c.request.method, c.request.path, c.request.body);
  const uuid = response.body?.bulk_uuid;
  if ((response.status !== 200 && response.status !== 202) || typeof uuid !== 'string' || uuid === '') {
    throw new Error(`write case ${c.name}: HTTP ${response.status}, no bulk_uuid`);
  }
  const { polls, ops } = await pollUntilClosed(c, uuid);
  const query = new URLSearchParams(c.verify.request.query).toString();
  const verify = { request: c.verify.request, response: await get(`${c.verify.request.path}?${query}`) };
  const recording = { request: c.request, response, polls, verify };
  const text = `${JSON.stringify(recording, null, 2)}\n`;
  assertNoToken(text, `write recording ${c.name}`);
  await writeFile(join(root, 'test', 'recordings', 'write', `${c.name}.json`), text);
  const states = [...ops].sort((a, b) => a.id - b.id).map((op) => op.status).join(',');
  console.log(`test/recordings/write/${c.name}.json written (polls=${polls.length}, states ${states})`);
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

  const writeCases = JSON.parse(await readFile(join(root, 'test', 'write-cases.json'), 'utf8'));
  await mkdir(join(root, 'test', 'recordings', 'write'), { recursive: true });
  for (const c of writeCases) await recordWrite(c);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'record failed');
  process.exit(1);
});
