// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

interface DryRun {
  globalCacheInputs?: { files?: Record<string, string> };
}

describe('Turborepo cache inputs (CI must not replay stale results)', () => {
  it('treats the root lint, type-check and test configuration as global inputs', () => {
    const out = execFileSync('pnpm', ['exec', 'turbo', 'run', 'lint', '--filter=@aiops/core', '--dry=json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const files = Object.keys((JSON.parse(out) as DryRun).globalCacheInputs?.files ?? {});
    for (const f of ['tsconfig.base.json', 'eslint.config.js', 'eslint.boundaries.js', 'vitest.shared.ts', '.nvmrc']) {
      expect(files).toContain(f);
    }
  }, 60_000);
});
