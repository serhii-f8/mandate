// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * The single-file MCP Apps bundles (UI-1, UI-6): `WIDGET=<name> vite build -c vite.widget.config.ts`
 * writes `dist/ui/<name>.html`, one document with every script and style inline.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const WIDGETS = ['changeset', 'approval'] as const;
const widget = WIDGETS.find((w) => w === process.env.WIDGET);
if (widget === undefined) throw new Error(`WIDGET must be one of ${WIDGETS.join(', ')}`);
// Always a production bundle, also when the caller runs under NODE_ENV=test (a Vitest child): Vite
// reads NODE_ENV after loading this file (vite 8.3.8 resolveConfig), and React's development build
// would exceed the 600 KB limit.
process.env.NODE_ENV = 'production';

export default defineConfig({
  // The root makes the output dist/ui/<name>.html, not dist/ui/src/widget/<name>.html (ADR 0036 R12).
  root: 'src/widget',
  plugins: [react(), viteSingleFile()],
  logLevel: 'warn',
  build: {
    // rolldownOptions: Vite 8 marks rollupOptions deprecated (ruling F2).
    rolldownOptions: { input: `${widget}.html` },
    outDir: '../../dist/ui',
    emptyOutDir: false,
    minify: true,
  },
});
