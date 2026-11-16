import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli } from './cli.js';

const VALID_DIR = fileURLToPath(new URL('../test/fixtures/valid', import.meta.url));

async function run(argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runCli(argv, (line) => lines.push(line));
  return { code, lines };
}

describe('CFG-3 validate command', () => {
  it('exits 0 with a summary for a valid directory', async () => {
    expect(await run(['validate', VALID_DIR])).toEqual({ code: 0, lines: ['Configuration valid: 1 connections, 2 operations, 2 roles'] });
  });

  it('exits 1 with one located line per issue for an invalid directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiops-cli-'));
    try {
      await cp(VALID_DIR, dir, { recursive: true });
      await writeFile(join(dir, 'roles.yaml'), 'version: 1\nroles:\n  - id: content_manager\n    grants:\n      - operation: catalog.nope\n');
      const { code, lines } = await run(['validate', dir]);
      expect(code).toBe(1);
      expect(lines).toContain('roles.yaml:5:9 roles[0].grants[0].operation: names an operation that is not defined');
      expect(lines.at(-1)).toMatch(/^Configuration invalid: \d+ issues?$/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it.each([[[]], [['validate']], [['explain', 'x']]])('exits 2 with usage for %j', async (argv) => {
    const { code, lines } = await run(argv);
    expect(code).toBe(2);
    expect(lines[0]).toMatch(/^usage: aiops-config validate <dir>/);
  });
});
