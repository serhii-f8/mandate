// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkReport, diffReport, headerVersion, sdkReport } from '../versioning/api-report-lib.mjs';

const cli = fileURLToPath(new URL('../versioning/api-report.mjs', import.meta.url));

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'api-report-'));
  mkdirSync(join(dir, 'sub'));
  writeFileSync(
    join(dir, 'index.d.ts'),
    "export * from './b.js';  \n/** doc */\nexport type A = import('./sub/c.js').C;\n// note\n//# sourceMappingURL=index.d.ts.map\n",
  );
  writeFileSync(join(dir, 'b.d.ts'), '/* block\n comment */\nexport declare const b: "// not a comment";\n');
  writeFileSync(join(dir, 'sub', 'c.d.ts'), 'export interface C { x: number }\n');
  writeFileSync(join(dir, 'unreachable.d.ts'), 'export declare const hidden = 1;\n');
  return dir;
}

describe('NFR-18 api report', () => {
  it('lists only reachable files, sorted', () => {
    const r = sdkReport(fixture(), '1.0.0');
    const files = [...r.matchAll(/^\/\/ file: (.+)$/gm)].map((m) => m[1]);
    expect(files).toEqual(['b.d.ts', 'index.d.ts', 'sub/c.d.ts']);
    expect(r).not.toContain('hidden');
  });

  it('strips comments and source map lines but keeps string content', () => {
    const r = sdkReport(fixture(), '1.0.0');
    expect(r).not.toMatch(/doc|note|block|sourceMappingURL/);
    expect(r).toContain('"// not a comment"');
    expect(r).not.toMatch(/[ \t]$/m);
  });

  it('is stable across runs and carries the version in the exact header', () => {
    const dir = fixture();
    const r = sdkReport(dir, '1.2.3');
    expect(sdkReport(dir, '1.2.3')).toBe(r);
    expect(r.split('\n')[0]).toBe('// @aiops/connector-sdk 1.2.3 public API report — generated, do not edit');
    expect(headerVersion(r)).toBe('1.2.3');
  });

  it('diffReport is empty for equal input and marks changed lines', () => {
    expect(diffReport('a\nb\n', 'a\nb\n')).toBe('');
    expect(diffReport('a\nb\n', 'a\nc\n')).toBe('- b\n+ c\n');
  });

  it('--check passes on the committed report and the generator output is current', () => {
    const r = spawnSync('node', [cli, 'connector-sdk', '--check'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('--check logic fails with a diff after an edit and on a header version mismatch', () => {
    const dir = fixture();
    const fresh = sdkReport(dir, '1.0.0');
    expect(checkReport(fresh, fresh, '1.0.0')).toEqual([]);
    const edited = fresh.replace('x: number', 'x: string');
    const stale = checkReport(edited, fresh, '1.0.0');
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(/- .*x: string[\s\S]*\+ .*x: number/);
    expect(checkReport(sdkReport(dir, '0.9.0'), sdkReport(dir, '0.9.0'), '1.0.0')[0]).toMatch(/header version 0\.9\.0/);
  });

  it('CLI rejects an unknown subject', () => {
    expect(spawnSync('node', [cli, 'nope'], { encoding: 'utf8' }).status).toBe(2);
  });
});
