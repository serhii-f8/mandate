// @ts-check
/**
 * Package-boundary rules (CLAUDE.md "Package boundaries", ADR 0010).
 * Imported by eslint.config.js and exercised by tooling/test/boundaries.unit.test.ts,
 * which lints violating samples so a rule that stops matching fails the build.
 */

const apps = { group: ['@aiops/api', '@aiops/api/*', '@aiops/worker', '@aiops/worker/*'], message: 'Packages must not import an app.' };

/** Every workspace package except the ones listed. */
function workspaceExcept(/** @type {string[]} */ allowed, /** @type {string} */ message) {
  return { regex: `^@aiops/(?!(${allowed.join('|')})(/|$))`, message };
}

const nodeIo = ['node:http', 'node:https', 'node:net', 'node:dgram', 'node:child_process', 'http', 'https', 'net', 'child_process'];

/** @type {import('eslint').Linter.Config[]} */
export const boundaryRules = [
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeIo.map((name) => ({ name, message: 'packages/core does no I/O; use a port owned by core.' })),
          patterns: [
            { group: ['@nestjs/*'], message: 'packages/core is framework-free (no NestJS).' },
            { group: ['@temporalio/*'], message: 'packages/core is framework-free (no Temporal).' },
            { group: ['drizzle-orm', 'drizzle-orm/*', 'pg', 'pg/*', 'postgres'], message: 'packages/core has no database driver.' },
            { group: ['undici', 'axios', 'node-fetch', 'got', 'ky'], message: 'packages/core has no HTTP client.' },
            { group: ['@modelcontextprotocol/*'], message: 'packages/core does not depend on the MCP SDK.' },
            workspaceExcept([], 'packages/core imports no other workspace package.'),
          ],
        },
      ],
    },
  },
  {
    files: ['packages/adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [workspaceExcept(['connector-sdk'], 'Adapters depend on @aiops/connector-sdk only.')] }],
    },
  },
  {
    files: ['presets/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [workspaceExcept(['connector-sdk', 'config'], 'Presets use only @aiops/connector-sdk and @aiops/config.')] },
      ],
    },
  },
  {
    files: ['packages/connector-sdk/**/*.ts', 'packages/config/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [apps, { group: ['@aiops/db', '@aiops/db/*', '@aiops/adapters', '@aiops/adapters/*'], message: 'Public interfaces stay independent of implementations.' }] },
      ],
    },
  },
  {
    files: ['packages/db/**/*.ts', 'packages/widgets/**/*.ts', 'packages/testing/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [apps] }] },
  },
  {
    files: ['apps/worker/src/workflows/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^node:', message: 'Workflow code is deterministic: no Node built-ins (CLAUDE.md, ADR 0006).' },
            {
              group: ['fs', 'fs/*', 'path', 'os', 'crypto', 'http', 'https', 'net', 'child_process', 'process', 'timers', 'worker_threads'],
              message: 'Workflow code is deterministic: no Node built-ins (CLAUDE.md, ADR 0006).',
            },
            { group: ['@nestjs/*', 'drizzle-orm', 'drizzle-orm/*', 'pg'], message: 'Workflow code does no I/O; use an activity.' },
            { regex: '^@temporalio/(?!workflow$|common$)', message: 'Workflow code may import only @temporalio/workflow and @temporalio/common.' },
            workspaceExcept(['core'], 'Workflow code may import only @aiops/core.'),
          ],
        },
      ],
    },
  },
];
