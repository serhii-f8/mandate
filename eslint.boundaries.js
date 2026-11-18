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

const ioNames = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'indexedDB'];
const ioMessage = 'Widgets do no network or storage I/O; data comes from props (SEC-1, UI-6).';
const rawHtmlMessage = 'Values render as text (SEC-5).';
const noDangerousHtml = { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: rawHtmlMessage };
const mcpSdk = ['@modelcontextprotocol/*'];

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
    // Tests may also use the shared fakes (fake upstream); production code may not.
    files: ['packages/adapters/src/**/*.test.ts', 'packages/adapters/test/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [workspaceExcept(['connector-sdk', 'testing'], 'Adapter tests depend on @aiops/connector-sdk and @aiops/testing only.')] },
      ],
    },
  },
  {
    files: ['packages/upstream/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [workspaceExcept(['core', 'config', 'connector-sdk'], 'packages/upstream depends on @aiops/core, @aiops/config and @aiops/connector-sdk only.')] },
      ],
    },
  },
  {
    files: ['packages/upstream/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [workspaceExcept(['core', 'config', 'connector-sdk', 'testing'], 'packages/upstream tests may also use @aiops/testing.')] },
      ],
    },
  },
  {
    files: ['packages/temporal/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [workspaceExcept(['core'], 'packages/temporal depends on @aiops/core only.')] }],
    },
  },
  {
    files: ['presets/*/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [workspaceExcept(['connector-sdk', 'config'], 'Presets use only @aiops/connector-sdk and @aiops/config.')] },
      ],
    },
  },
  {
    // Contract tests (NFR-17) run the preset through the real adapter and the shared fakes.
    files: ['presets/*/src/**/*.test.ts', 'presets/*/test/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            workspaceExcept(
              ['connector-sdk', 'config', 'adapters', 'testing'],
              'Preset tests use only @aiops/connector-sdk, @aiops/config, @aiops/adapters and @aiops/testing.',
            ),
          ],
        },
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
    files: ['packages/db/**/*.ts', 'packages/widgets/**/*.ts', 'packages/widgets/**/*.tsx', 'packages/testing/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [apps] }] },
  },
  {
    // W1: widget code, the bridge included, takes its data from props and renders values as text.
    files: ['packages/widgets/src/**/*.ts', 'packages/widgets/src/**/*.tsx'],
    rules: {
      'no-restricted-globals': ['error', ...ioNames.map((name) => ({ name, message: ioMessage }))],
      'no-restricted-properties': [
        'error',
        ...['window', 'globalThis'].flatMap((object) => ioNames.map((property) => ({ object, property, message: ioMessage }))),
      ],
      'no-restricted-syntax': [
        'error',
        noDangerousHtml,
        { selector: 'AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]', message: rawHtmlMessage },
        { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: rawHtmlMessage },
      ],
    },
  },
  {
    // W2: only src/widget/ talks to the MCP Apps bridge; the library never imports the widget entries.
    files: ['packages/widgets/src/{components,views}/**/*.{ts,tsx}', 'packages/widgets/src/{model,format,poll,paging,index}.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            apps,
            { group: mcpSdk, message: 'Only packages/widgets/src/widget/ talks to the MCP Apps bridge (UI-1).' },
            { group: ['**/widget', '**/widget/*'], message: 'The library does not import the widget entries (UI-1).' },
          ],
        },
      ],
    },
  },
  {
    // W3: the trusted page uses the widgets library over REST, never the widget entries or the MCP SDK.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@aiops/widgets/*', '!@aiops/widgets/styles.css'], message: 'apps/web uses the library, not the widget entries (UI-1).' },
            { group: mcpSdk, message: 'The trusted page talks REST only.' },
          ],
        },
      ],
      'no-restricted-syntax': ['error', noDangerousHtml],
    },
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
            // `(/|$)` rejects the package root and every other subpath of @aiops/temporal.
            workspaceExcept(['temporal/contract'], 'Workflow code may import only @aiops/temporal/contract (it re-exports the core types it needs).'),
          ],
        },
      ],
    },
  },
];
