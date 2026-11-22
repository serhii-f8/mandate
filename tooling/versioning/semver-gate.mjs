#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
// Usage: node tooling/versioning/semver-gate.mjs [--base <ref>]  (NFR-18)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { judge, versionOf } from './semver-gate-lib.mjs';

const REPORTS = [
  { path: 'packages/connector-sdk/api-report.d.ts', kind: 'sdk' },
  { path: 'packages/config/schema/mandate-config.v1.json', kind: 'config' },
  { path: 'packages/config/schema/mandate-preset.v1.json', kind: 'preset' },
];

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });

/**
 * The commit to compare with: the merge base of HEAD and `--base <ref>` (default `main`, else
 * `origin/main`). When that is HEAD itself (running on main), the first parent, so a local merge
 * into main is still gated. Exits 2 when an explicit base does not resolve, or when no default
 * base resolves under CI; otherwise prints `skipped: no base`.
 */
function resolveBase(argv) {
  const i = argv.indexOf('--base');
  const explicit = i >= 0;
  if (explicit && !argv[i + 1]) {
    console.error('--base needs a ref');
    process.exit(2);
  }
  const candidates = explicit ? [argv[i + 1]] : ['main', 'origin/main'];
  let found;
  for (const ref of candidates) {
    const r = git('merge-base', 'HEAD', ref);
    if (r.status === 0 && r.stdout.trim()) {
      found = r.stdout.trim();
      break;
    }
  }
  if (!found) {
    if (explicit) {
      console.error(`cannot resolve --base ${argv[i + 1]} (no merge base with HEAD)`);
      process.exit(2);
    }
    if (process.env.CI) {
      console.error('no base: neither main nor origin/main resolves (CI needs the base branch; fetch it)');
      process.exit(2);
    }
    return undefined;
  }
  const head = git('rev-parse', 'HEAD').stdout.trim();
  if (found === head) {
    const parent = git('rev-parse', '--verify', '--quiet', 'HEAD^1');
    if (parent.status === 0 && parent.stdout.trim()) return parent.stdout.trim();
  }
  return found;
}

const base = resolveBase(process.argv.slice(2));
if (!base) {
  console.log('skipped: no base');
  process.exit(0);
}
let failed = false;
for (const { path, kind } of REPORTS) {
  const listed = git('ls-tree', '--name-only', base, '--', path);
  if (listed.status !== 0) {
    console.log(`FAIL ${path}: cannot read the base (${listed.stderr.trim()})`);
    failed = true;
    continue;
  }
  const inBase = listed.stdout.trim() !== '';
  const inTree = existsSync(path);
  if (!inBase && !inTree) {
    console.log(`skipped ${path}: not present`);
    continue;
  }
  if (inBase && !inTree) {
    console.log(`FAIL ${path}: report removed (breaking)`);
    failed = true;
    continue;
  }
  const current = readFileSync(path, 'utf8');
  if (!inBase) {
    console.log(`ok ${path}: new report (${versionOf(current, kind)})`);
    continue;
  }
  const old = git('show', `${base}:${path}`);
  if (old.status !== 0) {
    console.log(`FAIL ${path}: cannot read the base (${old.stderr.trim()})`);
    failed = true;
    continue;
  }
  // A base report whose version header the current format cannot read was written before the
  // report format was renamed: there is nothing to compare line by line, so it counts as new.
  let oldVersion;
  try {
    oldVersion = versionOf(old.stdout, kind);
  } catch {
    console.log(`ok ${path}: base report has no version header, compared as a new report (${versionOf(current, kind)})`);
    continue;
  }
  const r = judge(old.stdout, current, oldVersion, versionOf(current, kind));
  console.log(`${r.ok ? 'ok' : 'FAIL'} ${path}: ${r.message}`);
  if (!r.ok) failed = true;
}
process.exit(failed ? 1 : 0);
