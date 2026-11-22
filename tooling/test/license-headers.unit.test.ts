// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addHeader, hasHeader, needsHeader } from '../license-headers-lib.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const TS = '// SPDX-License-Identifier: Apache-2.0\n// Copyright 2026 The Mandate Authors\n';
const SH = '# SPDX-License-Identifier: Apache-2.0\n# Copyright 2026 The Mandate Authors\n';

describe('license headers: needsHeader, hasHeader and addHeader', () => {
  it('needsHeader selects source types and excludes generated and recorded paths', () => {
    for (const p of ['a.ts', 'x/b.tsx', 'c.js', 'd.mjs', 'e.cjs', 'scripts/f.sh', 'Dockerfile', 'apps/api/Dockerfile', 'api.Dockerfile']) {
      expect(needsHeader(p), p).toBe(true);
    }
    for (const p of [
      'package.json',
      'packages/config/schema/mandate-config.v1.json',
      'README.md',
      'packages/db/migrations/0001_x.ts',
      'spikes/s/a.ts',
      'apps/worker/test/workflow-histories/h.js',
      'apps/web/dist/a.js',
      'x/test/recordings/r.ts',
      'packages/connector-sdk/api-report.d.ts',
    ]) {
      expect(needsHeader(p), p).toBe(false);
    }
  });

  it('addHeader prepends the // header to TypeScript', () => {
    expect(addHeader('const a = 1;\n', 'a.ts')).toBe(`${TS}const a = 1;\n`);
    expect(hasHeader(addHeader('x\n', 'a.ts'), 'a.ts')).toBe(true);
    expect(hasHeader('x\n', 'a.ts')).toBe(false);
  });

  it('addHeader puts the header after a shebang and hasHeader requires the shebang on line 1', () => {
    const out = addHeader('#!/usr/bin/env bash\nset -e\n', 'run.sh');
    expect(out).toBe(`#!/usr/bin/env bash\n${SH}set -e\n`);
    expect(hasHeader(out, 'run.sh')).toBe(true);
    // header before the shebang breaks execution: not accepted
    expect(hasHeader(`${SH}#!/usr/bin/env bash\nset -e\n`, 'run.sh')).toBe(false);
    expect(hasHeader(`#!/usr/bin/env node\n${TS}x\n`, 'a.mjs')).toBe(true);
  });

  it('sh and Dockerfile use #', () => {
    expect(addHeader('echo\n', 'a.sh')).toBe(`${SH}echo\n`);
    expect(addHeader('FROM node\n', 'apps/api/Dockerfile')).toBe(`${SH}FROM node\n`);
  });

  it('addHeader is idempotent', () => {
    for (const [t, p] of [['x\n', 'a.ts'], ['#!/bin/sh\nx\n', 'a.sh'], ['FROM a\n', 'Dockerfile']] as const) {
      const once = addHeader(t, p);
      expect(addHeader(once, p)).toBe(once);
    }
  });
});

describe('license headers on every tracked source file', () => {
  it('lists no tracked file without the header', () => {
    const r = spawnSync('node', ['tooling/license-headers.mjs'], { cwd: root, encoding: 'utf8' });
    expect(r.stdout, r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
