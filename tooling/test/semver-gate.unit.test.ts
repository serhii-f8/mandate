// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
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
    const sdk = (v: string) => `// @mandate/connector-sdk ${v} public API report — generated, do not edit\nexport declare const CONNECTOR_SDK_VERSION = "${v}";\nexport type A = 1;\n`;
    expect(judge(sdk('1.0.0'), sdk('1.0.1'), '1.0.0', '1.0.1')).toMatchObject({ ok: true, kind: 'none' });
    const cfg = (v: string) => `{\n  "a": 1,\n  "x-mandate-schema-version": "${v}"\n}\n`;
    expect(judge(cfg('1.0.0'), cfg('1.0.1'), '1.0.0', '1.0.1').kind).toBe('none');
  });
  it('an optional key appended to a JSON object is additive', () => {
    const r = judge('{\n  "a": 1,\n  "b": 2\n}\n', '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n', '1.0.0', '1.1.0');
    expect(r).toMatchObject({ ok: true, kind: 'additive' });
  });
  it('versionOf reads both header forms', () => {
    expect(versionOf('// @mandate/connector-sdk 1.2.3 public API report — generated, do not edit\n', 'sdk')).toBe('1.2.3');
    expect(versionOf('{\n  "x-mandate-schema-version": "2.0.0"\n}', 'config')).toBe('2.0.0');
    expect(() => versionOf('nothing', 'sdk')).toThrow();
  });

  describe('context-keyed classification', () => {
    const sdk = (body: string) => `// @mandate/connector-sdk 1.0.0 public API report — generated, do not edit\n${body}`;
    const iface = 'export interface Ctx {\n    readonly id: string;\n    run(): void;\n}\nexport declare class Impl {\n    x: number;\n}\n';
    const cfg = (inner: string) =>
      `{\n  "properties": {\n    "name": {\n      "type": "string"${inner}\n    },\n    "mode": {\n      "enum": [\n        "a"\n      ],\n      "type": "string"\n    }\n  },\n  "required": [\n    "name"\n  ],\n  "type": "object"\n}\n`;

    it('NFR-18 a key added to an existing required array is breaking', () => {
      const r = judge(cfg(''), cfg('').replace('"name"\n  ]', '"name",\n    "mode"\n  ]'), '1.0.0', '1.1.0');
      expect(r).toMatchObject({ ok: false, kind: 'breaking' });
    });
    it('NFR-18 a required array added to an existing object schema is breaking', () => {
      const old = '{\n  "properties": {\n    "a": {\n      "type": "string"\n    }\n  },\n  "type": "object"\n}\n';
      const next = '{\n  "properties": {\n    "a": {\n      "type": "string"\n    }\n  },\n  "required": [\n    "a"\n  ],\n  "type": "object"\n}\n';
      expect(judge(old, next, '1.0.0', '1.1.0')).toMatchObject({ ok: false, kind: 'breaking' });
    });
    it('NFR-18 a non-optional member added to an interface body is breaking', () => {
      for (const member of ['    mustImplement(): void;', '    foo: string;', '    readonly bar: number;']) {
        const next = iface.replace('    run(): void;', `    run(): void;\n${member}`);
        expect(judge(sdk(iface), sdk(next), '1.0.0', '1.1.0'), member).toMatchObject({ ok: false, kind: 'breaking' });
      }
    });
    it('NFR-18 a non-optional member added to a type-literal body is breaking', () => {
      const old = 'export type T = {\n    readonly a: string;\n    readonly nested: {\n        readonly b: string;\n    };\n};\n';
      const top = old.replace('    readonly a: string;', '    readonly a: string;\n    readonly c: string;');
      const nested = old.replace('        readonly b: string;', '        readonly b: string;\n        readonly d: string;');
      expect(judge(sdk(old), sdk(top), '1.0.0', '1.1.0').kind).toBe('breaking');
      expect(judge(sdk(old), sdk(nested), '1.0.0', '1.1.0').kind).toBe('breaking');
    });
    it('NFR-18 an optional member added to an interface is additive', () => {
      const next = iface.replace('    run(): void;', '    run(): void;\n    foo?: string;\n    readonly opt?: {\n        readonly inner: string;\n    };\n    hook?(): void;');
      expect(judge(sdk(iface), sdk(next), '1.0.0', '1.1.0')).toMatchObject({ ok: true, kind: 'additive' });
    });
    it('NFR-18 a member added to a class body and a new top-level export are additive', () => {
      const next = iface.replace('    x: number;', '    x: number;\n    y: string;') + 'export interface Fresh {\n    readonly must: string;\n}\nexport declare function f(): void;\n';
      expect(judge(sdk(iface), sdk(next), '1.0.0', '1.1.0')).toMatchObject({ ok: true, kind: 'additive' });
    });
    it('NFR-18 a member type changed in one interface while added in another is breaking', () => {
      const old = 'export interface A {\n    durationMs: number;\n}\nexport declare class B {\n    other: string;\n}\n';
      const next = 'export interface A {\n    durationMs: string;\n}\nexport declare class B {\n    other: string;\n    durationMs: number;\n}\n';
      expect(judge(sdk(old), sdk(next), '1.0.0', '1.1.0')).toMatchObject({ ok: false, kind: 'breaking' });
    });
    it('NFR-18 an added constraint keyword on an existing schema is breaking', () => {
      for (const kw of ['"minLength": 1', '"maxLength": 5', '"pattern": "^a$"', '"format": "uri"', '"minimum": 0', '"const": "x"', '"additionalProperties": false', '"uniqueItems": true']) {
        const r = judge(cfg(''), cfg(`,\n      ${kw}`), '1.0.0', '1.1.0');
        expect(r, kw).toMatchObject({ ok: false, kind: 'breaking' });
      }
      const withEnum = cfg(',\n      "enum": [\n        "x"\n      ]');
      expect(judge(cfg(''), withEnum, '1.0.0', '1.1.0').kind).toBe('breaking');
    });
    it('NFR-18 a value appended to an existing enum is additive', () => {
      const next = cfg('').replace('"a"\n      ]', '"a",\n        "b"\n      ]');
      expect(judge(cfg(''), next, '1.0.0', '1.1.0')).toMatchObject({ ok: true, kind: 'additive' });
    });
    it('NFR-18 a new optional property carrying constraints is additive', () => {
      const next = cfg('').replace('    "mode": {', '    "extra": {\n      "additionalProperties": false,\n      "minLength": 1,\n      "required": [\n        "z"\n      ],\n      "type": "string"\n    },\n    "mode": {');
      expect(judge(cfg(''), next, '1.0.0', '1.1.0')).toMatchObject({ ok: true, kind: 'additive' });
    });
    it('NFR-18 a required member added to a union variant continued on a root line is breaking', () => {
      const old = "export type TemplateValue = string | number | boolean | {\n    readonly arg: string;\n    readonly join?: string;\n}\n | {\n    readonly record: string;\n    readonly join?: string;\n};\nexport interface Next {\n    a: string;\n}\n";
      const next = old.replace('    readonly record: string;', '    readonly record: string;\n    readonly mustHave: string;');
      expect(judge(sdk(old), sdk(next), '1.0.0', '1.1.0')).toMatchObject({ ok: false, kind: 'breaking' });
      const optional = old.replace('    readonly record: string;', '    readonly record: string;\n    readonly mayHave?: string;');
      expect(judge(sdk(old), sdk(optional), '1.0.0', '1.1.0')).toMatchObject({ ok: true, kind: 'additive' });
    });
    it('NFR-18 an element appended to an existing allOf is breaking', () => {
      const old = '{\n  "allOf": [\n    {\n      "type": "object"\n    }\n  ]\n}\n';
      const next = '{\n  "allOf": [\n    {\n      "type": "object"\n    },\n    {\n      "required": [\n        "a"\n      ]\n    }\n  ]\n}\n';
      expect(judge(old, next, '1.0.0', '1.1.0')).toMatchObject({ ok: false, kind: 'breaking' });
    });
    it('NFR-18 a version downgrade without a surface change fails', () => {
      expect(judge(base, base, '1.2.0', '1.1.9')).toMatchObject({ ok: false, kind: 'none' });
      expect(judge(base, base, '1.2.0', '1.2.0-rc.1').ok).toBe(false);
      expect(judge(base, base, '1.2.0-rc.1', '1.2.0').ok).toBe(true);
    });
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
    const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
      const e: NodeJS.ProcessEnv = { ...process.env, ...extra };
      if (!('CI' in extra)) delete e.CI;
      return e;
    };
    const run = (dir: string, ...args: string[]) => spawnSync('node', [cli, ...args], { cwd: dir, encoding: 'utf8', env: env() });
    const sdkFile = 'packages/connector-sdk/api-report.d.ts';
    const commitReport = (dir: string, body: string, msg: string) => {
      mkdirSync(join(dir, 'packages/connector-sdk'), { recursive: true });
      writeFileSync(join(dir, sdkFile), `// @mandate/connector-sdk 1.0.0 public API report - generated, do not edit\n${body}`);
      spawnSync('git', ['add', '.'], { cwd: dir });
      spawnSync('git', ['commit', '-qm', msg], { cwd: dir });
    };

    it('without main it prints skipped: no base and exits 0', () => {
      const r = run(repo());
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('skipped: no base');
    });
    it('a report present at the base but removed at HEAD fails', () => {
      const dir = repo();
      const path = 'packages/connector-sdk/api-report.d.ts';
      mkdirSync(join(dir, 'packages/connector-sdk'), { recursive: true });
      writeFileSync(join(dir, path), '// @mandate/connector-sdk 1.0.0 public API report - generated, do not edit\nexport type A = 1;\n');
      spawnSync('git', ['add', '.'], { cwd: dir });
      spawnSync('git', ['commit', '-qm', 'report'], { cwd: dir });
      spawnSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
      writeFileSync(join(dir, 'f'), 'y');
      spawnSync('git', ['commit', '-qam', 'later'], { cwd: dir });
      rmSync(join(dir, path));
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(`FAIL ${path}: report removed (breaking)`);
    });
    it('NFR-18 a base report without a version header (written before a rename of the report format) counts as a new report', () => {
      const dir = repo();
      mkdirSync(join(dir, 'packages/connector-sdk'), { recursive: true });
      writeFileSync(join(dir, sdkFile), '// @former-name/connector-sdk 1.0.0 public API report - generated, do not edit\nexport type A = 1;\n');
      spawnSync('git', ['add', '.'], { cwd: dir });
      spawnSync('git', ['commit', '-qm', 'old format'], { cwd: dir });
      spawnSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
      commitReport(dir, 'export type B = 2;\n', 'renamed');
      const r = run(dir);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain(`ok ${sdkFile}: base report has no version header, compared as a new report (1.0.0)`);
    });
    it('NFR-18 an unresolvable --base exits 2', () => {
      const dir = repo();
      const r = run(dir, '--base', 'not-a-ref');
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('cannot resolve --base not-a-ref');
    });
    it('NFR-18 without a base under CI it exits 2', () => {
      const r = spawnSync('node', [cli], { cwd: repo(), encoding: 'utf8', env: env({ CI: 'true' }) });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('no base');
    });
    it('NFR-18 on main itself it compares with the first parent', () => {
      const dir = repo();
      commitReport(dir, 'export interface A {\n    a: string;\n}\n', 'report');
      commitReport(dir, 'export interface A {\n    a: string;\n    b: string;\n}\n', 'breaking');
      spawnSync('git', ['branch', 'main'], { cwd: dir });
      const r = run(dir);
      expect(r.status, r.stdout).toBe(1);
      expect(r.stdout).toContain(`FAIL ${sdkFile}: breaking change needs a major bump`);
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
