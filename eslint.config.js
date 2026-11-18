// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { boundaryRules } from './eslint.boundaries.js';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'spikes/**', '**/.turbo/**', '**/coverage/**', '.claude/**', '.superpowers/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // NestJS modules are decorated classes with static factories.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
  {
    // The web bundle runs in the browser.
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx', 'packages/widgets/src/**/*.ts', 'packages/widgets/src/**/*.tsx'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // The reference host page runs in a browser; Playwright callbacks reference `document`.
    files: ['tooling/acceptance/widget-host/**/*.js', 'tooling/acceptance/widget-host/**/*.mjs', 'tooling/acceptance/widget-host.mjs'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  ...boundaryRules,
);
