// Single-file build of the host page: tooling/acceptance/widget-host/dist/index.html.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [viteSingleFile()],
  logLevel: 'warn',
  build: { outDir: resolve(root, 'dist'), emptyOutDir: true, rollupOptions: { input: resolve(root, 'index.html') } },
});
