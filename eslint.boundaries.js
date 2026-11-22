// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
// @ts-check
/**
 * Package-boundary rules (CONTRIBUTING.md "Repository layout and boundaries", ADR 0010).
 * Imported by eslint.config.js and exercised by tooling/test/boundaries.unit.test.ts,
 * which lints violating samples so a rule that stops matching fails the build.
 */

const apps = { group: ['@mandate/api', '@mandate/api/*', '@mandate/worker', '@mandate/worker/*'], message: 'Packages must not import an app.' };

/** Every workspace package except the ones listed. */
function workspaceExcept(/** @type {string[]} */ allowed, /** @type {string} */ message) {
  return { regex: `^@mandate/(?!(${allowed.join('|')})(/|$))`, message };
}

const ioNames = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'indexedDB'];
const ioMessage = 'Widgets do no network or storage I/O; data comes from props (SEC-1, UI-6).';
const rawHtmlMessage = 'Values render as text (SEC-5).';
const noDangerousHtml = { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: rawHtmlMessage };
const mcpSdk = ['@modelcontextprotocol/*'];
const ioAlternation = ioNames.join('|');
const htmlSinks = '^(innerHTML|outerHTML)$';
/** W1's syntax bans; W2 repeats them because the last entry's `no-restricted-syntax` options win. */
const widgetSyntax = [
  noDangerousHtml,
  { selector: `AssignmentExpression > MemberExpression.left[property.name=/${htmlSinks}/]`, message: rawHtmlMessage },
  // Computed keys: e['innerHTML'] = x, e['insertAdjacentHTML'](...).
  { selector: `AssignmentExpression > MemberExpression.left[property.value=/${htmlSinks}/]`, message: rawHtmlMessage },
  { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: rawHtmlMessage },
  { selector: "CallExpression[callee.property.value='insertAdjacentHTML']", message: rawHtmlMessage },
  // A global reached through a nested window: globalThis.window.fetch, document.defaultView?.fetch, window.self.fetch.
  {
    selector: `MemberExpression[property.name=/^(${ioAlternation})$/][object.type='MemberExpression'][object.property.name=/^(window|self|globalThis|defaultView|parent|top|frames)$/]`,
    message: ioMessage,
  },
];

const nodeIo = ['node:http', 'node:https', 'node:net', 'node:dgram', 'node:child_process', 'http', 'https', 'net', 'child_process'];

/** Adapters (and their tests) never import OpenTelemetry; the hook is the connector SDK's `RequestInstrumentation`. */
const noTelemetryInAdapters = { group: ['@opentelemetry/*'], message: 'Adapters reach telemetry only through RequestInstrumentation (connector-sdk).' };

/** Only the MCP adapter talks to the MCP SDK; every other production package never imports it. */
const noMcpOutsideAdapter = { group: mcpSdk, message: 'Only packages/adapters/src/mcp/ talks to the MCP SDK (ADR 0050).' };

/**
 * The MCP client in the apps, the presets and packages/upstream, statically and through `import()` (design §6, ADR 0050).
 * The api still serves MCP with `@modelcontextprotocol/server`. Added to every entry that sets the same rule for those files,
 * because the last matching entry's options win.
 */
const mcpClientMessage = 'Only packages/adapters/src/mcp/ imports the MCP client (ADR 0050).';
const noMcpClient = { group: ['@modelcontextprotocol/client', '@modelcontextprotocol/client/*'], message: mcpClientMessage };
const noDynamicMcpClient = { selector: 'ImportExpression[source.value=/^@modelcontextprotocol\\/client(\\/|$)/]', message: mcpClientMessage };

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
    ignores: ['packages/adapters/src/mcp/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [workspaceExcept(['connector-sdk'], 'Adapters depend on @mandate/connector-sdk only.'), noTelemetryInAdapters, noMcpOutsideAdapter] },
      ],
    },
  },
  {
    // The MCP adapter: the same rules without the MCP SDK ban. It sits before the test entry (ruling F19),
    // so that entry's options win for src/mcp/*.test.ts and those tests keep the shared fakes.
    files: ['packages/adapters/src/mcp/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [workspaceExcept(['connector-sdk'], 'Adapters depend on @mandate/connector-sdk only.'), noTelemetryInAdapters] },
      ],
    },
  },
  {
    // Tests may also use the shared fakes (fake upstream); production code may not.
    files: ['packages/adapters/src/**/*.test.ts', 'packages/adapters/test/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            workspaceExcept(['connector-sdk', 'testing'], 'Adapter tests depend on @mandate/connector-sdk and @mandate/testing only.'),
            noTelemetryInAdapters,
          ],
        },
      ],
    },
  },
  {
    files: ['packages/upstream/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            workspaceExcept(['core', 'config', 'connector-sdk'], 'packages/upstream depends on @mandate/core, @mandate/config and @mandate/connector-sdk only.'),
            noMcpOutsideAdapter,
          ],
        },
      ],
    },
  },
  {
    files: ['packages/upstream/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [workspaceExcept(['core', 'config', 'connector-sdk', 'testing'], 'packages/upstream tests may also use @mandate/testing.'), noMcpOutsideAdapter] },
      ],
    },
  },
  {
    files: ['packages/upstream/test/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [noMcpOutsideAdapter] }] },
  },
  {
    files: ['packages/temporal/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [workspaceExcept(['core'], 'packages/temporal depends on @mandate/core only.')] }],
    },
  },
  {
    files: ['presets/*/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [workspaceExcept(['connector-sdk', 'config'], 'Presets use only @mandate/connector-sdk and @mandate/config.'), noMcpClient] },
      ],
    },
  },
  {
    // Preset code runs from a preset directory outside the app's node_modules (CONN-8, OPS-5): at run time it
    // imports only `node:` built-ins and its own relative files, so @mandate/* is imported as types only.
    // Not linted: a relative or file: import that leaves the code directory (`../` out of dist, an absolute
    // file: URL). The src-to-dist mapping makes that inexact; the loader refuses a path outside the package
    // and docs/commands.md states the rule.
    files: ['presets/*/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@mandate/*'],
              allowTypeImports: true,
              message: 'Preset code runs outside the app’s node_modules: import @mandate packages as types only (CONN-8, OPS-5).',
            },
          ],
        },
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
              'Preset tests use only @mandate/connector-sdk, @mandate/config, @mandate/adapters and @mandate/testing.',
            ),
            noMcpClient,
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
        {
          patterns: [
            apps,
            { group: ['@mandate/db', '@mandate/db/*', '@mandate/adapters', '@mandate/adapters/*'], message: 'Public interfaces stay independent of implementations.' },
            noMcpOutsideAdapter,
          ],
        },
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
        ...['window', 'globalThis', 'self'].flatMap((object) => ioNames.map((property) => ({ object, property, message: ioMessage }))),
      ],
      'no-restricted-syntax': ['error', ...widgetSyntax],
    },
  },
  {
    // W2: only src/widget/ talks to the MCP Apps bridge; the library never imports the widget entries.
    // Everything in src/ except the widget entries, so a new file or directory is covered without editing this list.
    files: ['packages/widgets/src/**/*.{ts,tsx}'],
    ignores: ['packages/widgets/src/widget/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...widgetSyntax,
        { selector: 'ImportExpression[source.value=/^@modelcontextprotocol\\//]', message: 'Only packages/widgets/src/widget/ talks to the MCP Apps bridge (UI-1).' },
        { selector: 'ImportExpression[source.value=/(^|\\/)widget(\\/|$)/]', message: 'The library does not import the widget entries (UI-1).' },
        { selector: 'ImportExpression[source.value=/^@mandate\\/(api|worker)(\\/|$)/]', message: 'Packages must not import an app.' },
      ],
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
    files: ['apps/api/src/**/*.ts', 'apps/worker/src/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [noMcpClient] }] },
  },
  {
    // Dynamic imports of the client; apps/web repeats the selector because its own entry sets this rule.
    files: ['apps/*/src/**/*.{ts,tsx}', 'presets/*/src/**/*.ts', 'packages/upstream/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', noDynamicMcpClient] },
  },
  {
    // W3: the trusted page uses the widgets library over REST, never the widget entries or the MCP SDK.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@mandate/widgets/*', '!@mandate/widgets/styles.css'], message: 'apps/web uses the library, not the widget entries (UI-1).' },
            { group: mcpSdk, message: 'The trusted page talks REST only.' },
          ],
        },
      ],
      'no-restricted-syntax': ['error', noDangerousHtml, noDynamicMcpClient],
    },
  },
  {
    files: ['apps/worker/src/workflows/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^node:', message: 'Workflow code is deterministic: no Node built-ins (docs/conventions/temporal-workflows.md, ADR 0006).' },
            {
              group: ['fs', 'fs/*', 'path', 'os', 'crypto', 'http', 'https', 'net', 'child_process', 'process', 'timers', 'worker_threads'],
              message: 'Workflow code is deterministic: no Node built-ins (docs/conventions/temporal-workflows.md, ADR 0006).',
            },
            { group: ['@nestjs/*', 'drizzle-orm', 'drizzle-orm/*', 'pg'], message: 'Workflow code does no I/O; use an activity.' },
            { regex: '^@temporalio/(?!workflow$|common$)', message: 'Workflow code may import only @temporalio/workflow and @temporalio/common.' },
            // `(/|$)` rejects the package root and every other subpath of @mandate/temporal.
            workspaceExcept(['temporal/contract'], 'Workflow code may import only @mandate/temporal/contract (it re-exports the core types it needs).'),
            noMcpClient,
          ],
        },
      ],
    },
  },
];
