import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations from src/schema.ts. Migrations are committed and
// forward-only; never edit one that is on main (CLAUDE.md, ADR 0011).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
});
