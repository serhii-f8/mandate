#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
// Public API report generator (NFR-18).
// Usage: node tooling/versioning/api-report.mjs <subject> [--check]
// Subjects: connector-sdk, config, preset (preset document and package.json `mandate`, versioned with the SDK).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkReport, configReport, presetReport, sdkReport } from './api-report-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readVersion(pkgDir) {
  return JSON.parse(readFileSync(join(root, pkgDir, 'package.json'), 'utf8')).version;
}

async function loadConfigDist() {
  const dist = join(root, 'packages/config/dist/index.js');
  if (!existsSync(dist)) throw new Error('packages/config/dist is missing: run `pnpm --filter @mandate/config build`');
  return import(pathToFileURL(dist).href);
}

async function loadSdkDist() {
  const dist = join(root, 'packages/connector-sdk/dist/index.js');
  if (!existsSync(dist)) throw new Error('packages/connector-sdk/dist is missing: run `pnpm --filter @mandate/connector-sdk build`');
  return import(pathToFileURL(dist).href);
}

/** Each subject: where the report lives, the package version it must carry, and how to build it. */
const SUBJECTS = {
  'connector-sdk': {
    file: join(root, 'packages/connector-sdk/api-report.d.ts'),
    version: () => readVersion('packages/connector-sdk'),
    generate: (version) => {
      const dist = join(root, 'packages/connector-sdk/dist');
      if (!existsSync(join(dist, 'index.d.ts'))) {
        throw new Error('packages/connector-sdk/dist is missing: run `pnpm --filter @mandate/connector-sdk build`');
      }
      return sdkReport(dist, version);
    },
  },
  config: {
    file: join(root, 'packages/config/schema/mandate-config.v1.json'),
    // tooling has no @mandate/config dependency: the built package is imported by path.
    version: async () => (await loadConfigDist()).CONFIG_SCHEMA_VERSION,
    generate: async (version) => configReport((await loadConfigDist()).configDocumentSchema, version),
  },
  preset: {
    file: join(root, 'packages/config/schema/mandate-preset.v1.json'),
    // The preset format is versioned with the connector SDK (presets declare `mandate.sdk`).
    version: async () => (await loadSdkDist()).CONNECTOR_SDK_VERSION,
    generate: async (version) => {
      const config = await loadConfigDist();
      return presetReport(config.presetDocumentSchema, config.presetMandateSchema, version);
    },
  },
};

async function main(argv) {
  const [subject, ...flags] = argv;
  const spec = SUBJECTS[subject];
  if (!spec) {
    console.error(`usage: api-report.mjs <${Object.keys(SUBJECTS).join('|')}> [--check]`);
    return 2;
  }
  const version = await spec.version();
  const fresh = await spec.generate(version);
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

process.exitCode = await main(process.argv.slice(2));
