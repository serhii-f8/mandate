import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Names from @modelcontextprotocol/ext-apps 2.1.0 dist/src/spec.types.d.ts McpUiStyleVariableKey. */
const ALLOWED = [
  '--color-background-primary',
  '--color-background-secondary',
  '--color-text-primary',
  '--color-text-secondary',
  '--color-text-danger',
  '--color-text-success',
  '--color-border-primary',
  '--font-sans',
  '--font-mono',
  '--border-radius-md',
];

const css = readFileSync('src/styles.css', 'utf8');

describe('UI-6 stylesheet', () => {
  it('UI-6 every CSS variable is an MCP Apps variable with a fallback', () => {
    const uses = css.match(/var\(/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    const good = [...css.matchAll(/var\((--[a-z0-9-]+),\s*[^)]+\)/g)];
    // fallbacks may contain nested parens (light-dark(...)); count by names too
    const names = [...css.matchAll(/var\((--[a-z0-9-]+),/g)].map((m) => m[1]);
    expect(names).toHaveLength(uses.length);
    expect(good.length).toBeGreaterThan(0);
    for (const n of names) expect(ALLOWED).toContain(n);
  });

  it('UI-6 the stylesheet follows the host colour scheme and loads nothing', () => {
    expect(css).toContain('color-scheme: light dark');
    expect(css).not.toMatch(/url\(|@import|@font-face/);
  });
});
