import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The api serves the bundle under /app/ (apps/api/src/web/static.ts), so asset URLs are rooted there.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
