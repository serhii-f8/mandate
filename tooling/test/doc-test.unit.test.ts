// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { extract } from '../doc-test/extract.mjs';
import { PAGES } from '../doc-test/run.mjs';

const RUN = fileURLToPath(new URL('../doc-test/run.mjs', import.meta.url));
const SECTIONS = ['install', 'attach', 'role', 'bulk', 'backup'];
const fence = (code: string): string => '```bash\n' + code + '\n```';

describe('NFR-9 doc-test extract', () => {
  it('extracts marked blocks in page order', () => {
    const a = `<!-- doc-test: install -->\n${fence('echo a1')}\n\ntext\n<!-- doc-test: attach -->\n\n${fence('echo a2')}\n`;
    const b = `<!-- doc-test: install -->\n${fence('echo b1')}\n`;
    const out = extract([{ path: 'a.md', text: a }, { path: 'b.md', text: b }], SECTIONS);
    expect(out.get('install')?.map((x) => [x.path, x.index, x.code.trim(), x.alt])).toEqual([
      ['a.md', 1, 'echo a1', false],
      ['b.md', 2, 'echo b1', false],
    ]);
    expect(out.get('attach')?.map((x) => x.code.trim())).toEqual(['echo a2']);
  });

  it('ignores unmarked blocks', () => {
    const out = extract([{ path: 'a.md', text: `${fence('echo no')}\n` }], SECTIONS);
    expect(out.get('install')).toEqual([]);
  });

  it('collects alternates', () => {
    const text = `<!-- doc-test-alt: attach\necho one\necho two\n-->\n`;
    const out = extract([{ path: 'a.md', text }], SECTIONS);
    expect(out.get('attach')).toEqual([{ path: 'a.md', index: 1, code: 'echo one\necho two\n', alt: true }]);
  });

  it('refuses an unknown section, a dangling marker and an unterminated alternate, naming file and line', () => {
    expect(() => extract([{ path: 'x.md', text: `\n<!-- doc-test: nope -->\n${fence('a')}` }], SECTIONS)).toThrow(
      /x\.md:2: unknown doc-test section "nope"/,
    );
    expect(() => extract([{ path: 'y.md', text: `a\nb\n<!-- doc-test: install -->\ntext only\n` }], SECTIONS)).toThrow(
      /y\.md:3: .*without a following code fence/,
    );
    expect(() => extract([{ path: 'z.md', text: `<!-- doc-test-alt: attach\necho x\n` }], SECTIONS)).toThrow(
      /z\.md:1: unterminated doc-test-alt/,
    );
  });
});

describe('NFR-9 doc-test run', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function repo(pages: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'doc-test-unit-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'docs/guide'), { recursive: true });
    for (const p of PAGES) writeFileSync(join(dir, 'docs/guide', p), pages[p] ?? '');
    return dir;
  }
  const run = (dir: string, ...args: string[]) =>
    spawnSync(process.execPath, [RUN, dir, ...args], { encoding: 'utf8', env: { ...process.env, MY_TOKEN: '' } });

  it('runs sections; a failing block is named and later sections are skipped', () => {
    const dir = repo({
      'installation.md': `<!-- doc-test: install -->\n${fence('echo ok')}\n`,
      'connecting-magento.md': `<!-- doc-test: attach -->\n${fence('echo fine')}\n<!-- doc-test: attach -->\n${fence('echo before\nfalse')}\n<!-- doc-test: role -->\n${fence('true')}\n`,
    });
    const r = run(dir, 'install', 'attach', 'role');
    expect(r.status).toBe(1);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toBe('pass install');
    expect(lines[1]).toBe('fail attach block 2 exit 1: echo before');
    expect(lines[2]).toBe('skip role');
  });

  it('runs one section alone although later pages carry other sections', () => {
    const dir = repo({
      'installation.md': `<!-- doc-test: install -->\n${fence('echo ok')}\n`,
      'connecting-magento.md': `<!-- doc-test: attach -->\n${fence('false')}\n`,
    });
    const r = run(dir, 'install');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('pass install\n');
    expect(run(dir, 'bogus').status).toBe(2);
  });

  it('an exported variable of section 1 is visible in section 2; a plain assignment is not', () => {
    const dir = repo({
      'installation.md': `<!-- doc-test: install -->\n${fence('export KEPT="a b"\nPLAIN=lost')}\n`,
      'connecting-magento.md': `<!-- doc-test: attach -->\n${fence('test "$KEPT" = "a b"')}\n<!-- doc-test: role -->\n${fence('echo "${PLAIN:-unset}" | grep -qx unset')}\n`,
    });
    const r = run(dir, 'install', 'attach', 'role');
    expect(r.stdout).toBe('pass install\npass attach\npass role\n');
    expect(r.status).toBe(0);
  });

  it('a value of MY_TOKEN is masked in the log and the env file is not left in the repo', () => {
    const dir = repo({
      'installation.md': `<!-- doc-test: install -->\n${fence('export MY_TOKEN=s3cr3t-value\nCAROL_COOKIE=cookie-value\necho "token is $MY_TOKEN and $CAROL_COOKIE"')}\n`,
    });
    const r = run(dir, 'install');
    expect(r.status).toBe(0);
    const log = readFileSync(join(dir, '.doc-test.log'), 'utf8');
    expect(log).toContain('token is *** and ***');
    expect(log).not.toContain('s3cr3t-value');
    expect(log).not.toContain('cookie-value');
  });

  it('refuses a missing guide page', () => {
    const dir = repo({});
    rmSync(join(dir, 'docs/guide/first-bulk-update.md'));
    const r = run(dir, 'install');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/missing guide page docs\/guide\/first-bulk-update\.md/);
  });

  it('does not scan pages outside the five reading-order pages', () => {
    const dir = repo({ 'installation.md': `<!-- doc-test: install -->\n${fence('true')}\n` });
    writeFileSync(join(dir, 'docs/guide/operations.md'), `<!-- doc-test: nope -->\n${fence('false')}\n`);
    expect(run(dir, 'install').stdout).toBe('pass install\n');
  });

  it('runs blocks in reading order, with the ERR trap reporting the block that failed inside a function', () => {
    const dir = repo({
      'installation.md': `<!-- doc-test: install -->\n${fence('echo first >> order.txt')}\n`,
      'backup-and-restore.md': `<!-- doc-test: install -->\n${fence('echo last >> order.txt')}\n`,
      'connecting-magento.md': `<!-- doc-test: attach -->\n${fence('f() { false; }\nf')}\n`,
    });
    expect(run(dir, 'install', 'attach').stdout).toBe('pass install\nfail attach block 1 exit 1: f() { false; }\n');
    expect(readFileSync(join(dir, 'order.txt'), 'utf8')).toBe('first\nlast\n');
  });

  it('masks secret-named variables case-insensitively', () => {
    const dir = repo({ 'installation.md': `<!-- doc-test: install -->\n${fence('export api_Token=lower-secret-1\necho "v=$api_Token"')}\n` });
    run(dir, 'install');
    expect(readFileSync(join(dir, '.doc-test.log'), 'utf8')).not.toContain('lower-secret-1');
  });
});
