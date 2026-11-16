import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';
// The rules under test, exactly as eslint.config.js applies them.
import { boundaryRules } from '../../eslint.boundaries.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

let eslint: ESLint;

beforeAll(() => {
  // Only the boundary rules, without type information: the probe files are virtual.
  eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } }, ...boundaryRules],
  });
});

/** Lints one import statement as if it were a file at `filePath` (relative to the repository). */
async function restrictedImportErrors(filePath: string, specifier: string): Promise<number> {
  const code = `import * as m from '${specifier}';\nexport const x: unknown = m;\n`;
  const [result] = await eslint.lintText(code, { filePath: `${repoRoot}${filePath}` });
  if (result === undefined) throw new Error('ESLint returned no result');
  return result.messages.filter((m) => m.ruleId === 'no-restricted-imports').length;
}

describe('package boundaries (CLAUDE.md engineering conventions)', () => {
  describe('packages/core is free of frameworks, drivers and adapters', () => {
    it.each([
      '@nestjs/common',
      '@temporalio/client',
      'drizzle-orm',
      'drizzle-orm/pg-core',
      'pg',
      '@aiops/db',
      '@aiops/adapters',
      '@modelcontextprotocol/server',
      'node:http',
      'undici',
    ])('rejects an import of %s', async (specifier) => {
      expect(await restrictedImportErrors('packages/core/src/probe.ts', specifier)).toBe(1);
    });

    it('allows a relative import', async () => {
      expect(await restrictedImportErrors('packages/core/src/probe.ts', './caller.js')).toBe(0);
    });
  });

  it('adapters depend on the connector SDK only', async () => {
    expect(await restrictedImportErrors('packages/adapters/src/probe.ts', '@aiops/core')).toBe(1);
    expect(await restrictedImportErrors('packages/adapters/src/probe.ts', '@aiops/connector-sdk')).toBe(0);
  });

  it('adapter tests may also use the shared fakes, production code may not', async () => {
    expect(await restrictedImportErrors('packages/adapters/src/probe.ts', '@aiops/testing')).toBe(1);
    expect(await restrictedImportErrors('packages/adapters/src/http/probe.test.ts', '@aiops/testing')).toBe(0);
    expect(await restrictedImportErrors('packages/adapters/src/http/probe.test.ts', '@aiops/core')).toBe(1);
    expect(await restrictedImportErrors('packages/adapters/test/probe.ts', '@aiops/testing')).toBe(0);
  });

  it('presets use only the connector SDK and the configuration schema', async () => {
    expect(await restrictedImportErrors('presets/magento2-catalog/src/probe.ts', '@aiops/core')).toBe(1);
    expect(await restrictedImportErrors('presets/magento2-catalog/src/probe.ts', '@aiops/config')).toBe(0);
    expect(await restrictedImportErrors('presets/magento2-catalog/src/probe.ts', '@aiops/connector-sdk')).toBe(0);
    expect(await restrictedImportErrors('presets/magento2-catalog/src/probe.ts', '@aiops/adapters')).toBe(1);
    expect(await restrictedImportErrors('presets/magento2-catalog/src/probe.ts', '@aiops/testing')).toBe(1);
  });

  it('NFR-17 preset contract tests may also use the adapters and the shared fakes, nothing else', async () => {
    for (const file of ['presets/magento2-catalog/test/probe.unit.test.ts', 'presets/magento2-catalog/src/probe.test.ts']) {
      expect(await restrictedImportErrors(file, '@aiops/adapters')).toBe(0);
      expect(await restrictedImportErrors(file, '@aiops/testing')).toBe(0);
      expect(await restrictedImportErrors(file, '@aiops/config')).toBe(0);
      expect(await restrictedImportErrors(file, '@aiops/core')).toBe(1);
      expect(await restrictedImportErrors(file, '@aiops/db')).toBe(1);
      expect(await restrictedImportErrors(file, '@aiops/api')).toBe(1);
    }
  });

  describe('Temporal workflow code stays deterministic (EXE-10)', () => {
    it.each(['node:fs', 'fs', '@aiops/db', '@nestjs/common', 'drizzle-orm', '@aiops/adapters'])(
      'rejects an import of %s',
      async (specifier) => {
        expect(await restrictedImportErrors('apps/worker/src/workflows/probe.ts', specifier)).toBe(1);
      },
    );

    it('allows @temporalio/workflow', async () => {
      expect(await restrictedImportErrors('apps/worker/src/workflows/probe.ts', '@temporalio/workflow')).toBe(0);
    });
  });

  it('packages never import an app', async () => {
    expect(await restrictedImportErrors('packages/db/src/probe.ts', '@aiops/api')).toBe(1);
    expect(await restrictedImportErrors('packages/config/src/probe.ts', '@aiops/worker')).toBe(1);
  });
});
