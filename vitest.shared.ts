/**
 * Shared Vitest configuration. Every workspace package has a `vitest.config.ts`
 * that calls `packageConfig()`; its scripts select a project:
 *   test      -> unit         src/**\/*.test.ts            (no infrastructure)
 *   test:int  -> integration  test/integration/**\/*.int.test.ts
 *   test:e2e  -> e2e          test/e2e/**\/*.e2e.test.ts
 * Workspace packages resolve to their TypeScript sources through the
 * `@aiops/source` export condition (ADR 0010).
 */
import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { defaultServerConditions, type PluginOption } from 'vite';

/**
 * Vite's server conditions without `module`: Node loads the dependencies, and a package such as
 * `@opentelemetry/api` 1.9.1 maps `module` to an ESM build with extensionless imports that Node
 * cannot load ("Cannot find module .../build/esm/baggage/utils"). Its `default` (CommonJS) entry
 * is what Node itself resolves in production.
 */
const conditions = ['@aiops/source', ...defaultServerConditions.filter((c) => c !== 'module')];

export interface PackageConfigOptions {
  /** Extra Vite plugins, e.g. SWC for decorator metadata in `apps/api`. */
  readonly plugins?: PluginOption[];
  /** Test environment of the unit project, e.g. `jsdom` for `apps/web`; Node by default. */
  readonly unitEnvironment?: 'jsdom';
}

export function packageConfig(options: PackageConfigOptions = {}): ViteUserConfig {
  return defineConfig({
    plugins: options.plugins ?? [],
    resolve: { conditions },
    ssr: { resolve: { conditions, externalConditions: conditions } },
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'unit',
            include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.unit.test.ts'],
            ...(options.unitEnvironment === undefined ? {} : { environment: options.unitEnvironment }),
          },
        },
        {
          extends: true,
          test: {
            name: 'integration',
            include: ['test/integration/**/*.int.test.ts'],
            testTimeout: 120_000,
            hookTimeout: 180_000,
          },
        },
        {
          extends: true,
          test: {
            name: 'e2e',
            include: ['test/e2e/**/*.e2e.test.ts'],
            testTimeout: 120_000,
            hookTimeout: 180_000,
          },
        },
      ],
    },
  });
}
