#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
// Records the vendored spec and the contract-test responses from a Gitea sandbox (NFR-17).
// Needs GITEA_SANDBOX_URL (e.g. http://127.0.0.1:4391) and GITEA_SANDBOX_TOKEN
// (bash deploy/sandbox/gitea/token.sh).
//   pnpm --filter @aiops/gitea-issues record
// Writes spec/gitea.swagger.json (GET /swagger.v1.json filtered to the five preset endpoints and
// the definitions, parameters and responses they reference), test/recordings/<case>.json from
// test/cases.json and test/recordings/write/<case>.json from test/write-cases.json. Each file is
// { "exchanges": [ { request: {method, path, query?, body?}, response: {status, body} } ] } with
// the path relative to /api/v1, the type RecordedExchange of @aiops/testing. No request or
// response header is ever written and the token is never printed. The write cases change only
// issue 30 of acme/website; each is followed by a restore to the seeded title, state and labels
// (and deletion of the comment it created).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = (process.env.GITEA_SANDBOX_URL ?? '').replace(/\/+$/, '');
const token = (process.env.GITEA_SANDBOX_TOKEN ?? '').trim();
if (baseUrl === '' || token === '') {
  console.error('set GITEA_SANDBOX_URL and GITEA_SANDBOX_TOKEN');
  process.exit(2);
}
const api = `${baseUrl}/api/v1`;

/** The preset's endpoints: swagger path -> methods kept. */
const KEEP = {
  '/repos/{owner}/{repo}/issues': ['get'],
  '/repos/{owner}/{repo}/issues/{index}': ['get', 'patch'],
  '/repos/{owner}/{repo}/issues/{index}/labels': ['put'],
  '/repos/{owner}/{repo}/labels': ['get'],
  '/repos/{owner}/{repo}/issues/{index}/comments': ['post'],
};

/** Fails loudly instead of committing anything that looks like a credential. */
function assertNoToken(text, what, { headers = true } = {}) {
  // The spec legitimately names the Authorization header in its securityDefinitions; recordings never do.
  if (text.includes(token) || (headers && /authorization/i.test(text)) || /token [0-9a-f]{40}/i.test(text)) {
    throw new Error(`${what} contains a token-like value; not written`);
  }
}

async function call(method, path, query, json) {
  const qs = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
  const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
  const init = json === undefined ? { method, headers } : { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(json) };
  const res = await fetch(`${api}${path}${qs}`, init);
  const text = await res.text();
  let body;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path}: HTTP ${res.status}, not JSON`);
    }
  }
  return { status: res.status, body };
}

async function exchange(step) {
  const response = await call(step.method, step.path, step.query, step.body);
  const request = { method: step.method, path: step.path, ...(step.query === undefined ? {} : { query: step.query }), ...(step.body === undefined ? {} : { body: step.body }) };
  return { request, response: response.body === undefined ? { status: response.status } : response };
}

async function save(dir, name, exchanges) {
  const text = `${JSON.stringify({ exchanges }, null, 2)}\n`;
  assertNoToken(text, `recording ${name}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.json`), text);
  console.log(`${dir.slice(root.length + 1)}/${name}.json written (${exchanges.map((e) => e.response.status).join(',')})`);
}

function collectRefs(node, out) {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, out));
  else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.add(v);
      else collectRefs(v, out);
    }
  }
}

/** Filters the swagger document to KEEP plus the transitive #/definitions, #/parameters and #/responses. */
function filterSpec(spec) {
  const paths = {};
  for (const [p, methods] of Object.entries(KEEP)) {
    const item = spec.paths?.[p];
    if (item === undefined) throw new Error(`spec has no path ${p}`);
    paths[p] = {};
    if (item.parameters !== undefined) paths[p].parameters = item.parameters;
    for (const m of methods) {
      if (item[m] === undefined) throw new Error(`spec has no ${m} ${p}`);
      paths[p][m] = item[m];
    }
  }
  const out = { swagger: spec.swagger, info: spec.info, basePath: spec.basePath, schemes: spec.schemes, consumes: spec.consumes, produces: spec.produces, paths, definitions: {}, parameters: {}, responses: {}, securityDefinitions: spec.securityDefinitions, security: spec.security };
  const done = new Set();
  let pending = new Set();
  collectRefs(paths, pending);
  while (pending.size > 0) {
    const next = new Set();
    for (const ref of pending) {
      if (done.has(ref)) continue;
      done.add(ref);
      const m = /^#\/(definitions|parameters|responses)\/(.+)$/.exec(ref);
      if (m === null) throw new Error(`unsupported $ref ${ref}`);
      const target = spec[m[1]]?.[m[2]];
      if (target === undefined) throw new Error(`unresolved $ref ${ref}`);
      out[m[1]][m[2]] = target;
      collectRefs(target, next);
    }
    pending = next;
  }
  for (const k of ['definitions', 'parameters', 'responses', 'securityDefinitions', 'security', 'schemes', 'consumes', 'produces']) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

async function recordSpec() {
  const res = await fetch(`${baseUrl}/swagger.v1.json`);
  if (res.status !== 200) throw new Error(`swagger.v1.json: HTTP ${res.status}`);
  const text = `${JSON.stringify(filterSpec(await res.json()), null, 2)}\n`;
  assertNoToken(text, 'spec', { headers: false });
  await mkdir(join(root, 'spec'), { recursive: true });
  await writeFile(join(root, 'spec', 'gitea.swagger.json'), text);
  console.log('spec/gitea.swagger.json written');
}

/** Replaces { "$label": name } with the id from the case's own labels listing. */
function resolveLabels(value, labels) {
  if (Array.isArray(value)) return value.map((v) => resolveLabels(v, labels));
  if (value !== null && typeof value === 'object') {
    if (typeof value.$label === 'string') {
      const found = labels.find((l) => l.name === value.$label);
      if (found === undefined) throw new Error(`no label ${value.$label}`);
      return found.id;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveLabels(v, labels)]));
  }
  return value;
}

/** Restores issue 30 of acme/website to its seeded title, state and labels; deletes comments of the case. */
async function restore(createdComments) {
  const issue = '/repos/acme/website/issues/30';
  const labels = (await call('GET', '/repos/acme/website/labels', { page: '1', limit: '50' })).body;
  const docs = labels.find((l) => l.name === 'docs');
  await call('PATCH', issue, undefined, { title: 'Website issue 30', state: 'open' });
  await call('PUT', `${issue}/labels`, undefined, { labels: [docs.id] });
  for (const id of createdComments) await call('DELETE', `/repos/acme/website/issues/comments/${id}`);
}

async function main() {
  await recordSpec();
  const cases = JSON.parse(await readFile(join(root, 'test', 'cases.json'), 'utf8'));
  for (const c of cases) {
    const exchanges = [];
    for (const step of c.exchanges) exchanges.push(await exchange(step));
    await save(join(root, 'test', 'recordings'), c.name, exchanges);
  }
  const writeCases = JSON.parse(await readFile(join(root, 'test', 'write-cases.json'), 'utf8'));
  for (const c of writeCases) {
    const exchanges = [];
    const comments = [];
    let labels = [];
    try {
      for (const step of c.steps) {
        const resolved = { ...step, ...(step.body === undefined ? {} : { body: resolveLabels(step.body, labels) }) };
        const ex = await exchange(resolved);
        exchanges.push(ex);
        if (step.method === 'GET' && step.path.endsWith('/labels') && Array.isArray(ex.response.body)) labels = ex.response.body;
        if (step.method === 'POST' && typeof ex.response.body?.id === 'number') comments.push(ex.response.body.id);
      }
    } finally {
      await restore(comments);
    }
    await save(join(root, 'test', 'recordings', 'write'), c.name, exchanges);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'record failed');
  process.exit(1);
});
