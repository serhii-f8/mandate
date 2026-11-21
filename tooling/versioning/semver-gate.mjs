#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
// Usage: node tooling/versioning/semver-gate.mjs [--base <ref>]  (NFR-18)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { judge, versionOf } from './semver-gate-lib.mjs';

const REPORTS = [
  { path: 'packages/connector-sdk/api-report.d.ts', kind: 'sdk' },
  { path: 'packages/config/schema/aiops-config.v1.json', kind: 'config' },
];

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });

function resolveBase(argv) {
  const i = argv.indexOf('--base');
  const candidates = i >= 0 && argv[i + 1] ? [argv[i + 1]] : ['main', 'origin/main'];
  for (const ref of candidates) {
    const r = git('merge-base', 'HEAD', ref);
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return undefined;
}

const base = resolveBase(process.argv.slice(2));
if (!base) {
  console.log('skipped: no base');
  process.exit(0);
}
let failed = false;
for (const { path, kind } of REPORTS) {
  if (!existsSync(path)) {
    console.log(`skipped ${path}: not present`);
    continue;
  }
  const old = git('show', `${base}:${path}`);
  const current = readFileSync(path, 'utf8');
  if (old.status !== 0) {
    console.log(`ok ${path}: new report (${versionOf(current, kind)})`);
    continue;
  }
  const r = judge(old.stdout, current, versionOf(old.stdout, kind), versionOf(current, kind));
  console.log(`${r.ok ? 'ok' : 'FAIL'} ${path}: ${r.message}`);
  if (!r.ok) failed = true;
}
process.exit(failed ? 1 : 0);
