// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { judge, versionOf } from '../versioning/semver-gate-lib.mjs';

const cli = fileURLToPath(new URL('../versioning/semver-gate.mjs', import.meta.url));
const base = 'export type A = 1;\nexport type B = 2;\n';

describe('NFR-18 semver gate', () => {
  it('identical reports pass whatever the versions', () => {
    expect(judge(base, base, '1.2.0', '1.2.0')).toMatchObject({ ok: true, kind: 'none' });
    expect(judge(base, base, '1.2.0', '3.0.0').ok).toBe(true);
  });
  it('an added line with 1.0.0 to 1.1.0 passes', () => {
    expect(judge(base, base + 'export type C = 3;\n', '1.0.0', '1.1.0')).toMatchObject({ ok: true, kind: 'additive' });
  });
  it('an added line with 1.0.0 to 1.0.1 fails', () => {
    const r = judge(base, base + 'export type C = 3;\n', '1.0.0', '1.0.1');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('additive change needs a minor bump');
  });
  it('a removed line with 1.4.0 to 2.0.0 passes', () => {
    expect(judge(base, 'export type A = 1;\n', '1.4.0', '2.0.0')).toMatchObject({ ok: true, kind: 'breaking' });
  });
  it('a removed line with 1.4.0 to 1.5.0 fails', () => {
    const r = judge(base, 'export type A = 1;\n', '1.4.0', '1.5.0');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('breaking change needs a major bump');
  });
  it('a changed line counts as breaking', () => {
    const r = judge(base, 'export type A = 1;\nexport type B = 3;\n', '1.0.0', '1.1.0');
    expect(r).toMatchObject({ ok: false, kind: 'breaking' });
  });
  it('0.6.0 to 1.0.0 with removals passes', () => {
    expect(judge(base, 'export type A = 1;\n', '0.6.0', '1.0.0').ok).toBe(true);
  });
  it('an invalid version fails', () => {
    expect(judge(base, base + 'x\n', '1.0', '1.1.0').ok).toBe(false);
    expect(judge(base, base + 'x\n', '1.0.0', 'latest').ok).toBe(false);
  });
  it('a version-only change with a patch bump passes', () => {
    const sdk = (v: string) => `// @aiops/connector-sdk ${v} public API report — generated, do not edit\nexport declare const CONNECTOR_SDK_VERSION = "${v}";\nexport type A = 1;\n`;
    expect(judge(sdk('1.0.0'), sdk('1.0.1'), '1.0.0', '1.0.1')).toMatchObject({ ok: true, kind: 'none' });
    const cfg = (v: string) => `{\n  "a": 1,\n  "x-aiops-schema-version": "${v}"\n}\n`;
    expect(judge(cfg('1.0.0'), cfg('1.0.1'), '1.0.0', '1.0.1').kind).toBe('none');
  });
  it('an optional key appended to a JSON object is additive', () => {
    const r = judge('{\n  "a": 1,\n  "b": 2\n}\n', '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n', '1.0.0', '1.1.0');
    expect(r).toMatchObject({ ok: true, kind: 'additive' });
  });
  it('versionOf reads both header forms', () => {
    expect(versionOf('// @aiops/connector-sdk 1.2.3 public API report — generated, do not edit\n', 'sdk')).toBe('1.2.3');
    expect(versionOf('{\n  "x-aiops-schema-version": "2.0.0"\n}', 'config')).toBe('2.0.0');
    expect(() => versionOf('nothing', 'sdk')).toThrow();
  });

  describe('CLI', () => {
    function repo(): string {
      const dir = mkdtempSync(join(tmpdir(), 'semver-gate-'));
      const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
      git('init', '-q', '-b', 'work');
      git('config', 'user.email', 't@example.invalid');
      git('config', 'user.name', 't');
      writeFileSync(join(dir, 'f'), 'x');
      git('add', '.');
      git('commit', '-qm', 'one');
      return dir;
    }
    const run = (dir: string, ...args: string[]) => spawnSync('node', [cli, ...args], { cwd: dir, encoding: 'utf8' });

    it('without main it prints skipped: no base and exits 0', () => {
      const r = run(repo());
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('skipped: no base');
    });
    it('a report present at the base but removed at HEAD fails', () => {
      const dir = repo();
      const path = 'packages/connector-sdk/api-report.d.ts';
      mkdirSync(join(dir, 'packages/connector-sdk'), { recursive: true });
      writeFileSync(join(dir, path), '// @aiops/connector-sdk 1.0.0 public API report - generated, do not edit\nexport type A = 1;\n');
      spawnSync('git', ['add', '.'], { cwd: dir });
      spawnSync('git', ['commit', '-qm', 'report'], { cwd: dir });
      spawnSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
      rmSync(join(dir, path));
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(`FAIL ${path}: report removed (breaking)`);
    });
    it('an unresolvable --base is skipped', () => {
      const dir = repo();
      const r = run(dir, '--base', 'not-a-ref');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('skipped: no base');
    });
    it('with only origin/main it uses it as the base', () => {
      const dir = repo();
      spawnSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
      const r = run(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('skipped: no base');
    });
  });
});
