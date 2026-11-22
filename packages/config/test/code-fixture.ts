// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Loads the code fixture preset of `@mandate/testing` through the real loader (OPS-5). Each call
 * copies the fixture into a new temporary preset directory, so the process-wide code-import
 * cache never sees a changed tree under the same entry path.
 */
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_FIXTURE_PRESET_DIR } from '@mandate/testing';
import { loadConfigurationDirectory, type LoadResult } from '../src/load.js';

export const FIXTURE_PACKAGE = '@mandate/code-fixture-preset';
/** The file name preset issues carry. */
export const FIXTURE_PRESET_FILE = `${FIXTURE_PACKAGE}/preset.yaml`;

export const FIXTURE_CONFIG = `version: 1
presets:
  - { id: fixture, package: "${FIXTURE_PACKAGE}" }
connections:
  - id: items
    adapter: openapi
    base_url: https://items.example.test/api
    credential_ref: items-token
    preset: fixture
roles:
  - id: viewer
    grants:
      - { operation: fixture.search }
  - id: integration_admin
    grants: []
    manage_credentials: [items-token]
role_mapping:
  - { group: viewers, roles: [viewer] }
`;

/** The fixture's preset.yaml as committed. */
export function fixturePresetText(): Promise<string> {
  return readFile(join(CODE_FIXTURE_PRESET_DIR, 'preset.yaml'), 'utf8');
}

/**
 * The fixture's preset.yaml without `fixture.update`, whose `{ record }` template loads only
 * once per-record bindings exist (ledger F6). Operation indexes: 0 search, 1 get_many,
 * 2 set_tags, 3 ping, 4 boom.
 */
export async function presetWithoutUpdate(): Promise<string> {
  const text = await fixturePresetText();
  const start = text.indexOf('  - id: fixture.update\n');
  const end = text.indexOf('  - id: fixture.set_tags\n');
  if (start < 0 || end < start) throw new Error('the code fixture preset changed shape');
  return text.slice(0, start) + text.slice(end);
}

export interface CodeFixtureLoad {
  /** preset.yaml text; the committed one when absent. */
  readonly preset?: string;
  /** Edits package.json (parsed) before the load. */
  readonly packageJson?: (json: Record<string, unknown>) => Record<string, unknown>;
  /** Configuration files by name; `config.yaml` defaults to `FIXTURE_CONFIG`. */
  readonly config?: Readonly<Record<string, string>>;
}

/** Loads a configuration that binds a fresh copy of the fixture; created directories are pushed to `dirs`. */
export async function loadCodeFixture(dirs: string[], options: CodeFixtureLoad = {}): Promise<LoadResult> {
  const presets = await mkdtemp(join(tmpdir(), 'mandate-code-fixture-presets-'));
  dirs.push(presets);
  const dir = join(presets, 'code-fixture');
  await cp(CODE_FIXTURE_PRESET_DIR, dir, { recursive: true });
  if (options.preset !== undefined) await writeFile(join(dir, 'preset.yaml'), options.preset);
  if (options.packageJson !== undefined) {
    const json = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(dir, 'package.json'), JSON.stringify(options.packageJson(json)));
  }
  const config = await mkdtemp(join(tmpdir(), 'mandate-code-fixture-config-'));
  dirs.push(config);
  for (const [file, text] of Object.entries({ 'config.yaml': FIXTURE_CONFIG, ...options.config })) await writeFile(join(config, file), text);
  return loadConfigurationDirectory(config, { presetDirs: [presets] });
}
