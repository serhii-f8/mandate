// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
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
    overrideConfig: [
      // The plugin is registered here: eslint.config.js gets it from strictTypeChecked (F17).
      { files: ['**/*.ts', '**/*.tsx'], languageOptions: { parser: tseslint.parser }, plugins: { '@typescript-eslint': tseslint.plugin } },
      ...boundaryRules,
    ],
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

describe('package boundaries (CONTRIBUTING.md repository layout and boundaries)', () => {
  describe('packages/core is free of frameworks, drivers and adapters', () => {
    it.each([
      '@nestjs/common',
      '@temporalio/client',
      'drizzle-orm',
      'drizzle-orm/pg-core',
      'pg',
      '@mandate/db',
      '@mandate/adapters',
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
    expect(await restrictedImportErrors('packages/adapters/src/probe.ts', '@mandate/core')).toBe(1);
    expect(await restrictedImportErrors('packages/adapters/src/probe.ts', '@mandate/connector-sdk')).toBe(0);
  });

  it('NFR-11 adapters and their tests import no OpenTelemetry package', async () => {
    expect(await restrictedImportErrors('packages/adapters/src/probe.ts', '@opentelemetry/api')).toBe(1);
    expect(await restrictedImportErrors('packages/adapters/src/http/probe.test.ts', '@opentelemetry/api')).toBe(1);
    expect(await restrictedImportErrors('packages/upstream/src/probe.ts', '@opentelemetry/api')).toBe(0);
  });

  it('adapter tests may also use the shared fakes, production code may not', async () => {
    expect(await restrictedImportErrors('packages/adapters/src/probe.ts', '@mandate/testing')).toBe(1);
    expect(await restrictedImportErrors('packages/adapters/src/http/probe.test.ts', '@mandate/testing')).toBe(0);
    expect(await restrictedImportErrors('packages/adapters/src/http/probe.test.ts', '@mandate/core')).toBe(1);
    expect(await restrictedImportErrors('packages/adapters/test/probe.ts', '@mandate/testing')).toBe(0);
  });

  it('CONN-1 the MCP client is imported only under packages/adapters/src/mcp/', async () => {
    const sdk = '@modelcontextprotocol/client';
    for (const file of [
      'packages/adapters/src/probe.ts',
      'packages/adapters/src/http/probe.ts',
      'packages/upstream/src/probe.ts',
      'packages/config/src/probe.ts',
      'packages/connector-sdk/src/probe.ts',
    ]) {
      expect(await restrictedImportErrors(file, sdk), file).toBe(1);
    }
    expect(await restrictedImportErrors('packages/adapters/src/mcp/probe.ts', sdk)).toBe(0);
    expect(await restrictedImportErrors('packages/adapters/test/integration/probe.ts', sdk)).toBe(0);
    expect(await restrictedImportErrors('packages/adapters/src/mcp/probe.ts', '@mandate/core')).toBe(1);
    expect(await restrictedImportErrors('packages/adapters/src/mcp/probe.ts', '@mandate/testing')).toBe(1);
    expect(await restrictedImportErrors('packages/adapters/src/mcp/probe.ts', '@opentelemetry/api')).toBe(1);
    // Ruling F19: MCP adapter tests keep the shared fakes, and the SDK.
    expect(await restrictedImportErrors('packages/adapters/src/mcp/probe.test.ts', '@mandate/testing')).toBe(0);
    expect(await restrictedImportErrors('packages/adapters/src/mcp/probe.test.ts', sdk)).toBe(0);
    expect(await restrictedImportErrors('packages/adapters/src/mcp/probe.test.ts', '@mandate/core')).toBe(1);
  });

  it('CONN-1 the apps, the presets and packages/upstream never import the MCP client, statically or dynamically', async () => {
    const sdk = '@modelcontextprotocol/client';
    const dynamic = (specifier: string) => `export const m = import('${specifier}');\n`;
    for (const file of [
      'apps/api/src/probe.ts',
      'apps/api/src/mcp/probe.test.ts',
      'apps/worker/src/probe.ts',
      'apps/worker/src/workflows/probe.ts',
      'apps/web/src/probe.tsx',
      'presets/magento2-catalog/src/probe.ts',
      'presets/magento2-catalog/src/probe.test.ts',
      'packages/upstream/src/probe.ts',
      'packages/upstream/src/probe.test.ts',
      'packages/upstream/test/integration/probe.ts',
    ]) {
      expect(await restrictedImportErrors(file, sdk), file).toBe(1);
      expect(await restrictedImportErrors(file, `${sdk}/stdio`), file).toBe(1);
      expect(await ruleErrors(file, dynamic(sdk), 'no-restricted-syntax'), file).toBe(1);
    }
    // The api serves MCP: the server SDK stays allowed.
    expect(await restrictedImportErrors('apps/api/src/probe.ts', '@modelcontextprotocol/server')).toBe(0);
    expect(await ruleErrors('apps/api/src/probe.ts', dynamic('@modelcontextprotocol/server'), 'no-restricted-syntax')).toBe(0);
    // The MCP adapter itself keeps the client, statically and dynamically.
    expect(await ruleErrors('packages/adapters/src/mcp/probe.ts', dynamic(sdk), 'no-restricted-syntax')).toBe(0);
    // apps/web keeps its raw-HTML ban next to the new selector.
    expect(await ruleErrors('apps/web/src/probe.tsx', 'export const e = <div dangerouslySetInnerHTML={{ __html: "" }} />;\n', 'no-restricted-syntax')).toBe(1);
  });

  it('CONN-8 OPS-5 preset src imports @mandate packages as types only', async () => {
    const rule = '@typescript-eslint/no-restricted-imports';
    const file = 'presets/magento2-catalog/src/probe.ts';
    expect(await ruleErrors(file, "import { CONNECTOR_SDK_VERSION } from '@mandate/connector-sdk';\nexport const v: unknown = CONNECTOR_SDK_VERSION;\n", rule)).toBe(1);
    expect(await ruleErrors(file, "import type { PresetModule } from '@mandate/connector-sdk';\nexport type P = PresetModule;\n", rule)).toBe(0);
    // Tests run in the workspace and may import values.
    const test = 'presets/magento2-catalog/src/probe.test.ts';
    expect(await ruleErrors(test, "import { CONNECTOR_SDK_VERSION } from '@mandate/connector-sdk';\nexport const v: unknown = CONNECTOR_SDK_VERSION;\n", rule)).toBe(0);
  });

  it('presets use only the connector SDK and the configuration schema', async () => {
    expect(await restrictedImportErrors('presets/magento2-catalog/src/probe.ts', '@mandate/core')).toBe(1);
    expect(await restrictedImportErrors('presets/magento2-catalog/src/probe.ts', '@mandate/config')).toBe(0);
    expect(await restrictedImportErrors('presets/magento2-catalog/src/probe.ts', '@mandate/connector-sdk')).toBe(0);
    expect(await restrictedImportErrors('presets/magento2-catalog/src/probe.ts', '@mandate/adapters')).toBe(1);
    expect(await restrictedImportErrors('presets/magento2-catalog/src/probe.ts', '@mandate/testing')).toBe(1);
  });

  it('NFR-17 preset contract tests may also use the adapters and the shared fakes, nothing else', async () => {
    for (const file of ['presets/magento2-catalog/test/probe.unit.test.ts', 'presets/magento2-catalog/src/probe.test.ts']) {
      expect(await restrictedImportErrors(file, '@mandate/adapters')).toBe(0);
      expect(await restrictedImportErrors(file, '@mandate/testing')).toBe(0);
      expect(await restrictedImportErrors(file, '@mandate/config')).toBe(0);
      expect(await restrictedImportErrors(file, '@mandate/core')).toBe(1);
      expect(await restrictedImportErrors(file, '@mandate/db')).toBe(1);
      expect(await restrictedImportErrors(file, '@mandate/api')).toBe(1);
    }
  });

  it('EXE-1 packages/upstream depends on core, config and the connector SDK only', async () => {
    for (const spec of ['@mandate/db', '@mandate/adapters', '@mandate/api']) {
      expect(await restrictedImportErrors('packages/upstream/src/probe.ts', spec)).toBe(1);
    }
    for (const spec of ['@mandate/core', '@mandate/config', '@mandate/connector-sdk']) {
      expect(await restrictedImportErrors('packages/upstream/src/probe.ts', spec)).toBe(0);
    }
    expect(await restrictedImportErrors('packages/upstream/src/probe.test.ts', '@mandate/testing')).toBe(0);
    expect(await restrictedImportErrors('packages/upstream/src/probe.ts', '@mandate/testing')).toBe(1);
  });

  it('SEC-4 packages/temporal imports core only', async () => {
    for (const spec of ['@mandate/db', '@mandate/config', '@mandate/upstream', '@mandate/api']) {
      expect(await restrictedImportErrors('packages/temporal/src/probe.ts', spec)).toBe(1);
    }
    expect(await restrictedImportErrors('packages/temporal/src/probe.ts', '@mandate/core')).toBe(0);
  });

  describe('Temporal workflow code stays deterministic (EXE-10)', () => {
    it.each(['node:fs', 'fs', '@mandate/db', '@nestjs/common', 'drizzle-orm', '@mandate/adapters', '@mandate/core'])(
      'rejects an import of %s',
      async (specifier) => {
        expect(await restrictedImportErrors('apps/worker/src/workflows/probe.ts', specifier)).toBe(1);
      },
    );

    it('allows @temporalio/workflow', async () => {
      expect(await restrictedImportErrors('apps/worker/src/workflows/probe.ts', '@temporalio/workflow')).toBe(0);
    });

    it('EXE-10 workflow code may import @mandate/temporal/contract but not @mandate/temporal', async () => {
      expect(await restrictedImportErrors('apps/worker/src/workflows/probe.ts', '@mandate/temporal/contract')).toBe(0);
      expect(await restrictedImportErrors('apps/worker/src/workflows/probe.ts', '@mandate/temporal')).toBe(1);
      expect(await restrictedImportErrors('apps/worker/src/workflows/probe.ts', '@mandate/temporal/codec')).toBe(1);
      expect(await restrictedImportErrors('apps/worker/src/workflows/probe.ts', '@mandate/temporal/contract-extra')).toBe(1);
    });
  });

  it('packages never import an app', async () => {
    expect(await restrictedImportErrors('packages/db/src/probe.ts', '@mandate/api')).toBe(1);
    expect(await restrictedImportErrors('packages/config/src/probe.ts', '@mandate/worker')).toBe(1);
    expect(await restrictedImportErrors('packages/widgets/src/views/Probe.tsx', '@mandate/api')).toBe(1);
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

    it('UI-1 apps/web imports @mandate/widgets and its stylesheet, not its widget entries', async () => {
      const file = 'apps/web/src/pages/Probe.tsx';
      expect(await restrictedImportErrors(file, '@mandate/widgets')).toBe(0);
      expect(await restrictedImportErrors(file, '@mandate/widgets/styles.css')).toBe(0);
      expect(await restrictedImportErrors(file, '@mandate/widgets/widget/bridge')).toBe(1);
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
        for (const spec of ['../widget/bridge.js', '@modelcontextprotocol/ext-apps', '@mandate/api']) {
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
