// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BYTES = 614_400;
// Loading anything at runtime: a script, stylesheet or image from an address.
const DOCUMENT_REFERENCES = [/<script[^>]*\ssrc=/i, /<link\b/i, /<img\b/i];
// CSS loading, checked inside <style> blocks only: zod's `.url(` is inside every correct bundle (ruling F1).
const STYLE_REFERENCES = [/@import/, /url\(/];

function styleBlocks(html: string): string {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? '').join('\n');
}

/** Runs the package script; a failure carries the script's output, which names the bundle and the check. */
function buildWidgets(): void {
  try {
    execFileSync('pnpm', ['run', 'build:widgets'], { cwd: packageRoot, stdio: 'pipe' });
  } catch (e) {
    const out = e as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`build:widgets failed\n${String(out.stdout ?? '')}${String(out.stderr ?? '')}`, { cause: e });
  }
}

describe('widget bundles', () => {
  it('UI-1 UI-6 build:widgets produces two self-contained HTML documents under 600 KB', { timeout: 180_000 }, () => {
    buildWidgets();
    for (const name of ['changeset.html', 'approval.html']) {
      const file = join(packageRoot, 'dist', 'ui', name);
      const html = readFileSync(file, 'utf8');
      expect(html.slice(0, 14).toLowerCase(), name).toBe('<!doctype html');
      expect(statSync(file).size, name).toBeLessThanOrEqual(MAX_BYTES);
      for (const re of DOCUMENT_REFERENCES) expect(html, `${name} ${String(re)}`).not.toMatch(re);
      const css = styleBlocks(html);
      expect(css.length, `${name} has its styles inline`).toBeGreaterThan(0);
      for (const re of STYLE_REFERENCES) expect(css, `${name} ${String(re)}`).not.toMatch(re);
    }
  });
});
