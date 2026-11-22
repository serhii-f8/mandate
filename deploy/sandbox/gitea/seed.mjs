#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
// Seeds the Gitea sandbox (Phase 9). Idempotent. Usage:
//   GITEA_SANDBOX_TOKEN=<token with write:organization,write:repository,write:issue> \
//     node deploy/sandbox/gitea/seed.mjs [base-url]     # default http://127.0.0.1:4391
// Org acme; private repositories website (30 issues "Website issue NN") and internal (3 issues);
// labels bug, docs, feature, triage, wontfix in both. Website issue n carries labels by n mod 5
// (1 bug, 2 feature, 3 bug+triage, 4 none, 0 docs); issues 21-25 are closed. Every run resets
// issues 1-6 and 30 to their seeded title, state and labels. Never prints the token.

const base = (process.argv[2] ?? 'http://127.0.0.1:4391').replace(/\/+$/, '');
const api = `${base}/api/v1`;
const token = process.env.GITEA_SANDBOX_TOKEN;
if (!token) {
  console.error('GITEA_SANDBOX_TOKEN is required');
  process.exit(1);
}
const ORG = 'acme';
const LABELS = ['bug', 'docs', 'feature', 'triage', 'wontfix'];
const WEBSITE_ISSUES = 30;
const INTERNAL_ISSUES = 3;
const LABELS_BY_MOD = { 1: ['bug'], 2: ['feature'], 3: ['bug', 'triage'], 4: [], 0: ['docs'] };

async function call(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: `token ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

function must(res, what, ok = [200, 201]) {
  if (!ok.includes(res.status)) {
    console.error(`${what} failed with HTTP ${res.status}`);
    process.exit(1);
  }
  return res.json;
}

function unexpected() {
  console.error('sandbox state unexpected; run down.sh -v');
  process.exit(1);
}

// 201, or 409/422 followed by a GET, counts as present.
async function ensure(createPath, createBody, getPath, what) {
  const created = await call('POST', createPath, createBody);
  if (created.status === 201) return created.json;
  if (created.status === 409 || created.status === 422) return must(await call('GET', getPath), `${what} lookup`);
  return must(created, what);
}

async function labelIds(repo) {
  const ids = new Map();
  for (const name of LABELS) {
    const label = await ensureLabel(repo, name);
    ids.set(name, label.id);
  }
  return ids;
}

// Gitea 28.3.0 answers 201 and creates a duplicate when a label name already exists, so list
// first (paged, 50 per page) and create only a missing name. The first label of a name wins.
async function listLabels(repo) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const batch = must(await call('GET', `/repos/${ORG}/${repo}/labels?page=${page}&limit=50`), 'label list');
    all.push(...batch);
    if (batch.length < 50) return all;
  }
}

async function ensureLabel(repo, name) {
  const found = (await listLabels(repo)).find((l) => l.name === name);
  if (found) return found;
  return must(await call('POST', `/repos/${ORG}/${repo}/labels`, { name, color: '#ee0701' }), `label ${name}`);
}

async function seedRepo(repo, count, titleOf, labelsOf, closed) {
  await ensure(`/orgs/${ORG}/repos`, { name: repo, private: true }, `/repos/${ORG}/${repo}`, `repo ${repo}`);
  const ids = await labelIds(repo);
  const idsOf = (n) => labelsOf(n).map((name) => ids.get(name));
  for (let n = 1; n <= count; n += 1) {
    const existing = await call('GET', `/repos/${ORG}/${repo}/issues/${n}`);
    if (existing.status === 200) {
      if (existing.json.title !== titleOf(n) && !RESET.has(`${repo}:${n}`)) unexpected();
      continue;
    }
    if (existing.status !== 404) must(existing, `issue ${repo}#${n}`);
    const made = must(
      await call('POST', `/repos/${ORG}/${repo}/issues`, { title: titleOf(n), labels: idsOf(n) }),
      `create issue ${repo}#${n}`,
    );
    if (made.number !== n) unexpected();
    if (closed(n)) must(await call('PATCH', `/repos/${ORG}/${repo}/issues/${n}`, { state: 'closed' }), `close ${repo}#${n}`);
  }
  return { idsOf };
}

const RESET = new Set([1, 2, 3, 4, 5, 6, 30].map((n) => `website:${n}`));
const websiteTitle = (n) => `Website issue ${String(n).padStart(2, '0')}`;

must(
  await (async () => {
    const created = await call('POST', '/orgs', { username: ORG });
    if (created.status === 409 || created.status === 422) return call('GET', `/orgs/${ORG}`);
    return created;
  })(),
  'org acme',
);

const website = await seedRepo('website', WEBSITE_ISSUES, websiteTitle, (n) => LABELS_BY_MOD[n % 5], (n) => n >= 21 && n <= 25);
await seedRepo('internal', INTERNAL_ISSUES, (n) => `Internal issue ${String(n).padStart(2, '0')}`, () => [], () => false);

for (const n of [1, 2, 3, 4, 5, 6, 30]) {
  must(
    await call('PATCH', `/repos/${ORG}/website/issues/${n}`, { title: websiteTitle(n), state: 'open' }),
    `reset issue ${n}`,
    [201],
  );
  must(await call('PUT', `/repos/${ORG}/website/issues/${n}/labels`, { labels: website.idsOf(n) }), `reset labels ${n}`);
}

console.log(`SEEDED gitea website=${WEBSITE_ISSUES} internal=${INTERNAL_ISSUES} labels=${LABELS.length}`);
