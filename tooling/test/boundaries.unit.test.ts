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
    overrideConfig: [{ files: ['**/*.ts', '**/*.tsx'], languageOptions: { parser: tseslint.parser } }, ...boundaryRules],
  });
});

/** Lints `code` as if it were a file at `filePath` (relative to the repository) and counts one rule's errors. */
async function ruleErrors(filePath: string, code: string, ruleId: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: `${repoRoot}${filePath}` });
  if (result === undefined) throw new Error('ESLint returned no result');
  // A probe that does not parse yields no rule messages; never let that read as "0 errors".
  const fatal = result.messages.find((m) => m.fatal === true);
  if (fatal !== undefined) throw new Error(`ESLint could not parse the probe: ${fatal.message}`);
  return result.messages.filter((m) => m.ruleId === ruleId).length;
}

/** Lints one import statement as if it were a file at `filePath` (relative to the repository). */
async function restrictedImportErrors(filePath: string, specifier: string): Promise<number> {
  const code = `import * as m from '${specifier}';\nexport const x: unknown = m;\n`;
  return ruleErrors(filePath, code, 'no-restricted-imports');
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

  it('EXE-1 packages/upstream depends on core, config and the connector SDK only', async () => {
    for (const spec of ['@aiops/db', '@aiops/adapters', '@aiops/api']) {
      expect(await restrictedImportErrors('packages/upstream/src/probe.ts', spec)).toBe(1);
    }
    for (const spec of ['@aiops/core', '@aiops/config', '@aiops/connector-sdk']) {
      expect(await restrictedImportErrors('packages/upstream/src/probe.ts', spec)).toBe(0);
    }
    expect(await restrictedImportErrors('packages/upstream/src/probe.test.ts', '@aiops/testing')).toBe(0);
    expect(await restrictedImportErrors('packages/upstream/src/probe.ts', '@aiops/testing')).toBe(1);
  });

  it('SEC-4 packages/temporal imports core only', async () => {
    for (const spec of ['@aiops/db', '@aiops/config', '@aiops/upstream', '@aiops/api']) {
      expect(await restrictedImportErrors('packages/temporal/src/probe.ts', spec)).toBe(1);
    }
    expect(await restrictedImportErrors('packages/temporal/src/probe.ts', '@aiops/core')).toBe(0);
  });

  describe('Temporal workflow code stays deterministic (EXE-10)', () => {
    it.each(['node:fs', 'fs', '@aiops/db', '@nestjs/common', 'drizzle-orm', '@aiops/adapters', '@aiops/core'])(
      'rejects an import of %s',
      async (specifier) => {
        expect(await restrictedImportErrors('apps/worker/src/workflows/probe.ts', specifier)).toBe(1);
      },
    );

    it('allows @temporalio/workflow', async () => {
      expect(await restrictedImportErrors('apps/worker/src/workflows/probe.ts', '@temporalio/workflow')).toBe(0);
    });

    it('EXE-10 workflow code may import @aiops/temporal/contract but not @aiops/temporal', async () => {
      expect(await restrictedImportErrors('apps/worker/src/workflows/probe.ts', '@aiops/temporal/contract')).toBe(0);
      expect(await restrictedImportErrors('apps/worker/src/workflows/probe.ts', '@aiops/temporal')).toBe(1);
      expect(await restrictedImportErrors('apps/worker/src/workflows/probe.ts', '@aiops/temporal/codec')).toBe(1);
      expect(await restrictedImportErrors('apps/worker/src/workflows/probe.ts', '@aiops/temporal/contract-extra')).toBe(1);
    });
  });

  it('packages never import an app', async () => {
    expect(await restrictedImportErrors('packages/db/src/probe.ts', '@aiops/api')).toBe(1);
    expect(await restrictedImportErrors('packages/config/src/probe.ts', '@aiops/worker')).toBe(1);
    expect(await restrictedImportErrors('packages/widgets/src/views/Probe.tsx', '@aiops/api')).toBe(1);
  });

  describe('widgets (UI-1, SEC-1, SEC-5)', () => {
    it('UI-1 widget views, components and models import nothing from the MCP SDK', async () => {
      const sdk = '@modelcontextprotocol/ext-apps/react';
      for (const file of ['packages/widgets/src/views/Probe.tsx', 'packages/widgets/src/components/Probe.tsx', 'packages/widgets/src/model.ts']) {
        expect(await restrictedImportErrors(file, sdk)).toBe(1);
      }
      expect(await restrictedImportErrors('packages/widgets/src/widget/bridge.ts', sdk)).toBe(0);
    });

    it('UI-1 the library does not import the widget entries', async () => {
      expect(await restrictedImportErrors('packages/widgets/src/views/Probe.tsx', '../widget/bridge.js')).toBe(1);
    });

    it('UI-1 apps/web imports @aiops/widgets and its stylesheet, not its widget entries', async () => {
      const file = 'apps/web/src/pages/Probe.tsx';
      expect(await restrictedImportErrors(file, '@aiops/widgets')).toBe(0);
      expect(await restrictedImportErrors(file, '@aiops/widgets/styles.css')).toBe(0);
      expect(await restrictedImportErrors(file, '@aiops/widgets/widget/bridge')).toBe(1);
      expect(await restrictedImportErrors(file, '@modelcontextprotocol/ext-apps')).toBe(1);
    });

    it('SEC-1 widget code uses no network or storage globals', async () => {
      const samples = ["fetch('/x');\n", "localStorage.getItem('k');\n", "window.fetch('/x');\n", "new WebSocket('ws://x');\n"];
      for (const file of ['packages/widgets/src/widget/bridge.ts', 'packages/widgets/src/views/Probe.tsx']) {
        for (const code of samples) {
          const count =
            (await ruleErrors(file, code, 'no-restricted-globals')) + (await ruleErrors(file, code, 'no-restricted-properties'));
          expect(count, `${file}: ${code}`).toBe(1);
        }
      }
    });

    it('UI-1 every library file outside src/widget/ is covered, whatever its name or directory', async () => {
      for (const file of ['packages/widgets/src/test-fixtures.ts', 'packages/widgets/src/paging.test.tsx', 'packages/widgets/src/hooks/useX.ts']) {
        expect(await restrictedImportErrors(file, '@modelcontextprotocol/ext-apps'), file).toBe(1);
        expect(await restrictedImportErrors(file, '../widget/bridge.js'), file).toBe(1);
      }
      expect(await restrictedImportErrors('packages/widgets/src/widget/app/entry.tsx', '@modelcontextprotocol/ext-apps')).toBe(0);
    });

    it('UI-1 the library does not reach the bridge or the MCP SDK through a dynamic import', async () => {
      for (const file of ['packages/widgets/src/views/Probe.tsx', 'packages/widgets/src/test-fixtures.ts']) {
        for (const spec of ['../widget/bridge.js', '@modelcontextprotocol/ext-apps', '@aiops/api']) {
          expect(await ruleErrors(file, `export const m = import('${spec}');\n`, 'no-restricted-syntax'), `${file}: ${spec}`).toBe(1);
        }
        expect(await ruleErrors(file, "export const m = import('../model.js');\n", 'no-restricted-syntax')).toBe(0);
      }
      expect(await ruleErrors('packages/widgets/src/widget/bridge.ts', "export const m = import('@modelcontextprotocol/ext-apps');\n", 'no-restricted-syntax')).toBe(0);
    });

    it('SEC-1 widget code reaches no network or storage global through self, a nested window or defaultView', async () => {
      const samples = ["self.fetch('/x');\n", "globalThis.window.fetch('/x');\n", "document.defaultView?.fetch('/x');\n", "window['localStorage'].getItem('k');\n"];
      const rules = ['no-restricted-globals', 'no-restricted-properties', 'no-restricted-syntax'];
      for (const file of ['packages/widgets/src/widget/bridge.ts', 'packages/widgets/src/views/Probe.tsx']) {
        for (const code of samples) {
          let count = 0;
          for (const rule of rules) count += await ruleErrors(file, code, rule);
          expect(count, `${file}: ${code}`).toBe(1);
        }
      }
    });

    it('SEC-5 computed innerHTML and insertAdjacentHTML keys are caught too', async () => {
      for (const file of ['packages/widgets/src/widget/bridge.ts', 'packages/widgets/src/views/Probe.tsx']) {
        for (const code of ["document.body['innerHTML'] = 'x';\n", "document.body['outerHTML'] = 'x';\n", "document.body['insertAdjacentHTML']('beforeend', 'x');\n"]) {
          expect(await ruleErrors(file, code, 'no-restricted-syntax'), `${file}: ${code}`).toBe(1);
        }
      }
    });

    it('SEC-5 widget and web code never set raw HTML', async () => {
      const jsx = "export const X = () => <div dangerouslySetInnerHTML={{ __html: 'x' }} />;\n";
      expect(await ruleErrors('packages/widgets/src/views/Probe.tsx', jsx, 'no-restricted-syntax')).toBe(1);
      expect(await ruleErrors('apps/web/src/pages/Probe.tsx', jsx, 'no-restricted-syntax')).toBe(1);
      expect(await ruleErrors('packages/widgets/src/widget/bridge.ts', "document.body.innerHTML = 'x';\n", 'no-restricted-syntax')).toBe(1);
    });
  });
});
