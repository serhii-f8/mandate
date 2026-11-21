// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
// License header rules (NFR-18 release hygiene): which files carry the header, and how to add it.

const SLASH_EXT = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
const EXCLUDED_PREFIXES = [
  'spikes/',
  'packages/db/migrations/',
  'apps/worker/test/workflow-histories/',
  'packages/connector-sdk/api-report.d.ts',
];

const norm = (path) => path.replaceAll('\\', '/').replace(/^\.\//, '');
const base = (path) => norm(path).split('/').pop() ?? '';

function isDockerfile(path) {
  const b = base(path);
  return b === 'Dockerfile' || b.endsWith('.Dockerfile');
}

function commentPrefix(path) {
  return SLASH_EXT.some((e) => base(path).endsWith(e)) ? '//' : '#';
}

/** @param {string} path @returns {boolean} */
export function needsHeader(path) {
  const p = norm(path);
  if (EXCLUDED_PREFIXES.some((x) => p.startsWith(x))) return false;
  if (/(^|\/)dist\//.test(p) || /(^|\/)test\/recordings\//.test(p)) return false;
  const b = base(p);
  return SLASH_EXT.some((e) => b.endsWith(e)) || b.endsWith('.sh') || isDockerfile(p);
}

function headerOf(path) {
  const c = commentPrefix(path);
  return `${c} SPDX-License-Identifier: Apache-2.0\n${c} Copyright 2026 The AI Operations Layer Authors\n`;
}

// Splits a leading shebang line (kept with its newline) from the rest.
function splitShebang(text) {
  if (!text.startsWith('#!')) return ['', text];
  const nl = text.indexOf('\n');
  return nl < 0 ? [`${text}\n`, ''] : [text.slice(0, nl + 1), text.slice(nl + 1)];
}

/** @param {string} text @param {string} path @returns {boolean} */
export function hasHeader(text, path) {
  const [shebang, rest] = splitShebang(text);
  const header = headerOf(path);
  if (!rest.startsWith(header)) return false;
  // A shebang right after the header means the header sits on line 1: bash cannot run it.
  return shebang !== '' || !rest.slice(header.length).startsWith('#!');
}

/** @param {string} text @param {string} path @returns {string} */
export function addHeader(text, path) {
  if (hasHeader(text, path)) return text;
  const [shebang, rest] = splitShebang(text);
  return `${shebang}${headerOf(path)}${rest}`;
}
