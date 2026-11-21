#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
// Public API report generator (NFR-18).
// Usage: node tooling/versioning/api-report.mjs <subject> [--check]
// Subjects: connector-sdk. Task 4 adds `config` by registering it in SUBJECTS.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReport, sdkReport } from './api-report-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readVersion(pkgDir) {
  return JSON.parse(readFileSync(join(root, pkgDir, 'package.json'), 'utf8')).version;
}

/** Each subject: where the report lives, the package version it must carry, and how to build it. */
const SUBJECTS = {
  'connector-sdk': {
    file: join(root, 'packages/connector-sdk/api-report.d.ts'),
    version: () => readVersion('packages/connector-sdk'),
    generate: (version) => {
      const dist = join(root, 'packages/connector-sdk/dist');
      if (!existsSync(join(dist, 'index.d.ts'))) {
        throw new Error('packages/connector-sdk/dist is missing: run `pnpm --filter @aiops/connector-sdk build`');
      }
      return sdkReport(dist, version);
    },
  },
};

function main(argv) {
  const [subject, ...flags] = argv;
  const spec = SUBJECTS[subject];
  if (!spec) {
    console.error(`usage: api-report.mjs <${Object.keys(SUBJECTS).join('|')}> [--check]`);
    return 2;
  }
  const version = spec.version();
  const fresh = spec.generate(version);
  if (!flags.includes('--check')) {
    writeFileSync(spec.file, fresh);
    console.log(`wrote ${spec.file}`);
    return 0;
  }
  const committed = existsSync(spec.file) ? readFileSync(spec.file, 'utf8') : '';
  const problems = checkReport(committed, fresh, version);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    return 1;
  }
  console.log(`${subject} report is current`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
