#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
// Usage: node tooling/license-headers.mjs [--write] [paths...]  (default: git ls-files)
// Lists files missing the license header and exits 1; --write adds the header instead.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { addHeader, hasHeader, needsHeader } from './license-headers-lib.mjs';

const args = process.argv.slice(2);
const write = args.includes('--write');
let paths = args.filter((a) => a !== '--write');
if (paths.length === 0) {
  const r = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(2);
  }
  paths = r.stdout.split('\0').filter(Boolean);
}

const missing = [];
for (const p of paths) {
  if (!needsHeader(p) || !existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  if (hasHeader(text, p)) continue;
  if (write) writeFileSync(p, addHeader(text, p));
  else missing.push(p);
}
if (missing.length > 0) {
  console.log(missing.join('\n'));
  process.exit(1);
}
