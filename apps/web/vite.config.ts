// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The api serves the bundle under /app/ (apps/api/src/web/static.ts), so asset URLs are rooted there.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  // One React for the page and @aiops/widgets, which takes React as a peer.
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { outDir: 'dist', emptyOutDir: true },
});
