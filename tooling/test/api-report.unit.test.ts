// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkReport, configReport, diffReport, headerVersion, presetReport, sdkReport } from '../versioning/api-report-lib.mjs';

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
    expect(r.split('\n')[0]).toBe('// @mandate/connector-sdk 1.2.3 public API report — generated, do not edit');
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

describe('NFR-18 config schema report', () => {
  const schema = z.strictObject({
    zeta: z.string(),
    alpha: z.object({ y: z.number().default(1), b: z.string() }),
    refined: z.string().refine((v) => v.length > 1),
    shaped: z.unknown().transform((v) => v),
  });
  const report = () => configReport(schema, '1.2.3');
  interface Doc {
    $id: string;
    'x-mandate-schema-version': string;
    additionalProperties: boolean;
    properties: Record<string, { type?: string; required?: string[] }>;
  }
  const parsed = () => JSON.parse(report()) as Doc;

  it('keys are sorted recursively', () => {
    const keys = (v: unknown): string[] =>
      v && typeof v === 'object' ? Object.keys(v).flatMap((k) => [k, ...keys((v as Record<string, unknown>)[k])]) : [];
    const walk = (v: unknown): void => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const ks = Object.keys(v);
        expect(ks).toEqual([...ks].sort());
        Object.values(v).forEach(walk);
      }
    };
    walk(JSON.parse(report()));
    expect(keys(JSON.parse(report())).length).toBeGreaterThan(5);
    expect(report().endsWith('}\n')).toBe(true);
  });

  it('sets $id and x-mandate-schema-version', () => {
    const j = parsed();
    expect(j.$id).toBe('https://mandate.invalid/schema/mandate-config.v1.json');
    expect(j['x-mandate-schema-version']).toBe('1.2.3');
    expect(headerVersion(report())).toBe('1.2.3');
  });

  it('a strict object yields additionalProperties false', () => {
    expect(parsed().additionalProperties).toBe(false);
  });

  it('a refinement or transform does not throw and is exported as unconstrained', () => {
    const j = parsed();
    expect(j.properties.shaped).toEqual({});
    expect(j.properties.refined?.type).toBe('string');
  });

  it('describes the file as written: defaulted keys are not required', () => {
    expect(parsed().properties.alpha?.required).toEqual(['b']);
  });

  it('--check detects staleness and a version mismatch', () => {
    const fresh = report();
    expect(checkReport(fresh, fresh, '1.2.3')).toEqual([]);
    const stale = checkReport(fresh.replace('"string"', '"number"'), fresh, '1.2.3');
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(/report is stale/);
    expect(checkReport(fresh, fresh, '2.0.0')[0]).toMatch(/header version 1\.2\.3 differs from package\.json 2\.0\.0/);
  });

  it('CLI --check passes on the committed schema file', () => {
    const r = spawnSync('node', [cli, 'config', '--check'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });
});

describe('NFR-18 preset format report', () => {
  const doc = z.strictObject({ version: z.literal(1), spec: z.string().min(1).optional() });
  const mandate = z.strictObject({ sdk: z.string(), preset: z.string().default('preset.yaml') });
  interface Report {
    $id: string;
    'x-mandate-sdk-version': string;
    $defs: Record<string, { required?: string[]; $schema?: string }>;
  }

  it('NFR-18 carries the SDK version and both schemas', () => {
    const text = presetReport(doc, mandate, '1.2.3');
    const j = JSON.parse(text) as Report;
    expect(j.$id).toBe('https://mandate.invalid/schema/mandate-preset.v1.json');
    expect(j['x-mandate-sdk-version']).toBe('1.2.3');
    expect(headerVersion(text)).toBe('1.2.3');
    expect(Object.keys(j.$defs)).toEqual(['packageJsonMandate', 'presetDocument']);
    expect(j.$defs.presetDocument?.required).toEqual(['version']);
    expect(j.$defs.packageJsonMandate?.required).toEqual(['sdk']);
    expect(j.$defs.presetDocument?.$schema).toBeUndefined();
  });

  it('NFR-18 CLI --check passes on the committed preset report', () => {
    const r = spawnSync('node', [cli, 'preset', '--check'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });
});
