// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli } from './cli.js';

const VALID_DIR = fileURLToPath(new URL('../test/fixtures/valid', import.meta.url));
const DERIVED_DIR = fileURLToPath(new URL('../test/fixtures/derived', import.meta.url));
const WITH_PRESET_DIR = fileURLToPath(new URL('../test/fixtures/with-preset', import.meta.url));
const PRESET_DIR = fileURLToPath(new URL('../test/fixtures/preset-dir', import.meta.url));

const SPEC_SKIPPED = 'Spec checks skipped: run "mandate validate" in the api for the full check';
const PRESET_SKIPPED = 'Preset checks skipped: set MANDATE_PRESET_DIRS or pass --preset-dir for the full check';

async function run(argv: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runCli(argv, (line) => lines.push(line), env);
  return { code, lines };
}

describe('CFG-3 validate command', () => {
  it('exits 0 with a summary for a valid directory', async () => {
    expect(await run(['validate', VALID_DIR])).toEqual({ code: 0, lines: ['Configuration valid: 1 connections, 2 operations, 2 roles'] });
  });

  it('says when spec checks were skipped', async () => {
    expect(await run(['validate', DERIVED_DIR])).toEqual({
      code: 0,
      lines: ['Configuration valid: 1 connections, 2 operations, 0 roles', 'Spec checks skipped: run "mandate validate" in the api for the full check'],
    });
  });

  it('loads presets from --preset-dir, repeatable', async () => {
    expect(await run(['validate', WITH_PRESET_DIR, '--preset-dir', '/nonexistent/presets', '--preset-dir', PRESET_DIR])).toEqual({
      code: 0,
      lines: ['Configuration valid: 1 connections, 2 operations, 2 roles', SPEC_SKIPPED],
    });
  });

  it('loads presets from MANDATE_PRESET_DIRS (colon-separated)', async () => {
    expect(await run(['validate', WITH_PRESET_DIR], { MANDATE_PRESET_DIRS: `/nonexistent/presets:${PRESET_DIR}` })).toEqual({
      code: 0,
      lines: ['Configuration valid: 1 connections, 2 operations, 2 roles', SPEC_SKIPPED],
    });
  });

  it('skips preset checks without preset directories and says the configuration is not fully checked', async () => {
    expect(await run(['validate', WITH_PRESET_DIR])).toEqual({
      code: 0,
      lines: ['Configuration valid: 1 connections, 0 operations, 2 roles', PRESET_SKIPPED],
    });
  });

  it('exits 1 with one located line per issue for an invalid directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mandate-cli-'));
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

  it.each([[[]], [['validate']], [['explain', 'x']], [['validate', 'x', '--preset-dir']], [['validate', 'x', '--other', 'y']]])('exits 2 with usage for %j', async (argv) => {
    const { code, lines } = await run(argv);
    expect(code).toBe(2);
    expect(lines[0]).toMatch(/^usage: mandate-config validate <dir>/);
  });
});
