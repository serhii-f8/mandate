import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function manifest(path: string): Manifest {
  return JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')) as Manifest;
}

/** Runtime dependencies `packages/core` may have. Adding one is a reviewed decision. */
const CORE_ALLOWED_DEPENDENCIES: readonly string[] = [];

describe('package manifests (CLAUDE.md package boundaries)', () => {
  it('packages/core declares no runtime dependency outside the allow list', () => {
    const core = manifest('packages/core/package.json');
    const declared = [...Object.keys(core.dependencies ?? {}), ...Object.keys(core.peerDependencies ?? {})];
    expect(declared.filter((d) => !CORE_ALLOWED_DEPENDENCIES.includes(d))).toEqual([]);
  });

  it('packages/adapters depends on no workspace package except the connector SDK', () => {
    const deps = Object.keys(manifest('packages/adapters/package.json').dependencies ?? {});
    expect(deps.filter((d) => d.startsWith('@aiops/') && d !== '@aiops/connector-sdk')).toEqual([]);
  });
});
