// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

/** Text of the section under the heading `title` (up to the next heading of the same or higher level). */
function section(md: string, title: string): string {
  const m = new RegExp(`^(#+) ${title}\\s*$`, 'm').exec(md);
  if (!m?.[1]) return '';
  const rest = md.slice(m.index + m[0].length);
  const next = new RegExp(`^#{1,${m[1].length}} `, 'm').exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

describe('NFR-18 repository files for contributors', () => {
  it('NFR-18 contribution guide covers setup, tests, commits, migrations, Temporal versioning and public interfaces', () => {
    const md = read('CONTRIBUTING.md');
    for (const h of [
      'Development setup',
      'Repository layout and boundaries',
      'Tests',
      'Commits',
      'Database migrations',
      'Temporal workflow versioning',
      'Public interfaces and versioning',
      'Security issues',
      'License',
    ]) {
      expect(md, h).toMatch(new RegExp(`^#+ ${h}\\s*$`, 'm'));
    }
    const temporal = section(md, 'Temporal workflow versioning');
    for (const s of ['patched(', 'deprecatePatch', 'replay']) expect(temporal, s).toContain(s);
    expect(section(md, 'Security issues')).toContain('SECURITY.md');
  });

  it('NFR-18 code of conduct links the Contributor Covenant 2.1', () => {
    expect(read('CODE_OF_CONDUCT.md')).toContain('https://www.contributor-covenant.org/version/2/1/code_of_conduct/');
  });

  it('NFR-18 the image version label equals the root package version', () => {
    const version = (JSON.parse(read('package.json')) as { version: string }).version;
    const label = /^LABEL org\.opencontainers\.image\.version="([^"]+)"/m.exec(read('deploy/Dockerfile'));
    expect(label?.[1]).toBe(version);
  });
});
