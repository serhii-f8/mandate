// Checks the widget bundles (UI-1, UI-6): each is one HTML document of at most 600 KB that loads
// nothing from an address. `url(` and `@import` are CSS loading, so they are checked inside <style>
// blocks only; zod's `.url(` is inside every correct script (ADR 0036 ruling F1).
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 614_400;
const NAMES = ['changeset', 'approval'];
const DOCUMENT_REFERENCES = [/<script[^>]*\ssrc=/i, /<link\b/i, /<img\b/i];
const STYLE_REFERENCES = [/@import/, /url\(/];
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function styleBlocks(html) {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
}

function problemOf(file) {
  let html;
  try {
    html = readFileSync(file, 'utf8');
  } catch {
    return 'is missing';
  }
  const bytes = statSync(file).size;
  if (bytes > MAX_BYTES) return `has ${String(bytes)} bytes, more than ${String(MAX_BYTES)}`;
  if (!html.slice(0, 14).toLowerCase().startsWith('<!doctype html')) return 'does not start with <!doctype html';
  for (const re of DOCUMENT_REFERENCES) if (re.test(html)) return `contains ${String(re)}`;
  const css = styleBlocks(html);
  for (const re of STYLE_REFERENCES) if (re.test(css)) return `contains ${String(re)} in a <style> block`;
  return undefined;
}

let failed = false;
for (const name of NAMES) {
  const rel = `dist/ui/${name}.html`;
  const problem = problemOf(join(packageRoot, rel));
  if (problem === undefined) {
    console.log(`# built ${rel} (${String(statSync(join(packageRoot, rel)).size)} bytes)`);
  } else {
    console.error(`${rel} ${problem}`);
    failed = true;
  }
}
if (failed) process.exit(1);
