// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
// Public API reports (NFR-18). Reads built declaration files; no process access beyond the file system.
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { toJSONSchema } from 'zod';

/** Header line of the connector SDK report; `versionOf` in the semver gate reads it back. */
export function sdkHeader(version) {
  return `// @mandate/connector-sdk ${version} public API report — generated, do not edit`;
}

/** Removes block and line comments and sourceMappingURL lines from a declaration file. */
function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
    } else if (c === '/' && n === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '/' && n === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function normalise(source) {
  return stripComments(source)
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function relativeImports(source) {
  const found = new Set();
  const patterns = [/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g, /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g];
  for (const re of patterns) for (const m of source.matchAll(re)) found.add(m[1]);
  return [...found];
}

function resolveDeclaration(fromRel, spec) {
  const base = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  return base.replace(/\.js$/, '.d.ts');
}

/** Report of every declaration file reachable from `index.d.ts` in `distDir`. */
export function sdkReport(distDir, version) {
  const seen = new Map();
  const queue = ['index.d.ts'];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const path = join(distDir, rel);
    if (!existsSync(path)) throw new Error(`declaration file not found: ${rel}`);
    const text = readFileSync(path, 'utf8');
    seen.set(rel, normalise(text));
    // Imports are read from the comment-free text, so commented-out imports are ignored.
    for (const spec of relativeImports(stripComments(text))) queue.push(resolveDeclaration(rel, spec));
  }
  const body = [...seen.keys()].sort().map((rel) => `// file: ${rel}\n${seen.get(rel)}`);
  return `${[sdkHeader(version), ...body].join('\n\n')}\n`;
}

/** Minimal unified-like line diff; empty string when the inputs are equal. */
export function diffReport(a, b) {
  if (a === b) return '';
  const x = a.split('\n');
  const y = b.split('\n');
  const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i -= 1)
    for (let j = y.length - 1; j >= 0; j -= 1)
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      i += 1;
      j += 1;
    } else if (i < x.length && (j === y.length || dp[i + 1][j] >= dp[i][j + 1])) {
      out.push(`- ${x[i]}`);
      i += 1;
    } else {
      out.push(`+ ${y[j]}`);
      j += 1;
    }
  }
  return `${out.join('\n')}\n`;
}

/** Version carried by a report: the SDK header line or the config schema's version key; undefined when absent. */
export function headerVersion(report) {
  const m =
    /^\/\/ @mandate\/connector-sdk (\S+) public API report/m.exec(report) ??
    /^\s*"x-mandate-schema-version": "([^"]+)"/m.exec(report) ??
    /^\s*"x-mandate-sdk-version": "([^"]+)"/m.exec(report);
  return m ? m[1] : undefined;
}

const CONFIG_SCHEMA_ID = 'https://mandate.invalid/schema/mandate-config.v1.json';

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}

/**
 * JSON Schema of the configuration file as written (`io: 'input'`: defaulted keys optional;
 * refinements and transforms export as unconstrained), pretty-printed with sorted keys.
 */
export function configReport(schema, version) {
  const json = toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  const doc = sortKeys({ ...json, $id: CONFIG_SCHEMA_ID, 'x-mandate-schema-version': version });
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const PRESET_SCHEMA_ID = 'https://mandate.invalid/schema/mandate-preset.v1.json';

function inputSchema(schema) {
  const json = toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  delete json.$schema;
  return json;
}

/**
 * JSON Schema of the preset format, versioned with the connector SDK: the preset document
 * (`$defs.presetDocument`) and the `mandate` block of a preset's package.json
 * (`$defs.packageJsonMandate`). Same conventions as the configuration report.
 */
export function presetReport(presetDocumentSchema, mandateSchema, sdkVersion) {
  const doc = sortKeys({
    $id: PRESET_SCHEMA_ID,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: { packageJsonMandate: inputSchema(mandateSchema), presetDocument: inputSchema(presetDocumentSchema) },
    'x-mandate-sdk-version': sdkVersion,
  });
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Problems found when comparing a committed report with a fresh one; empty when current. */
export function checkReport(committed, fresh, version) {
  const problems = [];
  const carried = headerVersion(committed);
  if (carried !== version) problems.push(`header version ${carried ?? '(none)'} differs from package.json ${version}`);
  const diff = diffReport(committed, fresh);
  if (diff) problems.push(`report is stale; regenerate it\n${diff}`);
  return problems;
}
