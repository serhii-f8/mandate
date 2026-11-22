// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * Guards the reviewed conformance baselines (NFR-16): an entry needs a reason, and a scenario the
 * platform implements can never be excused as a whole, so a baseline cannot grow silently on a pin
 * bump. A single check of a must-pass scenario may be excused, with its reason (ADR 0055).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MUST_PASS } from './must-pass.ts';

const DIR = fileURLToPath(new URL('.', import.meta.url));
/** One baseline entry with its reason as a trailing comment (ADR 0055). */
const ENTRY_WITH_REASON = /^\s*-\s+([\w:/-]+)\s+#\s*\S/;

/** Problems of one baseline file's text; empty when the file is acceptable. */
function baselineProblems(text: string, mustPass: readonly string[]): string[] {
  const doc: unknown = parse(text);
  if (typeof doc !== 'object' || doc === null || Object.keys(doc).join() !== 'server') return ['the file must have exactly one key, server'];
  const entries: unknown = (doc as { server: unknown }).server;
  if (!Array.isArray(entries) || !entries.every((e): e is string => typeof e === 'string')) return ['server must be a list of strings'];
  const reasoned = text
    .split('\n')
    .map((line) => ENTRY_WITH_REASON.exec(line)?.[1])
    .filter((e): e is string => e !== undefined);
  const problems: string[] = [];
  for (const entry of entries) {
    if (reasoned.filter((r) => r === entry).length !== 1) problems.push(`${entry}: needs exactly one line with a reason comment`);
    if (mustPass.includes(entry)) problems.push(`${entry}: a must-pass scenario cannot be baselined as a whole`);
  }
  if (reasoned.length !== entries.length) problems.push('every list line must be one entry with a reason');
  return problems;
}

const baselines = readdirSync(DIR).filter((f) => /^expected-failures\.\d{4}-\d\d-\d\d\.yaml$/.test(f));

describe('NFR-16 every conformance baseline entry has a reason and no must-pass scenario is baselined', () => {
  it('NFR-16 the 2026-07-28 baseline exists', () => {
    expect(baselines).toContain('expected-failures.2026-07-28.yaml');
  });

  it.each(baselines)('NFR-16 %s is acceptable', (file) => {
    const revision = file.slice('expected-failures.'.length, -'.yaml'.length);
    expect(Object.keys(MUST_PASS)).toContain(revision);
    const mustPass = MUST_PASS[revision as keyof typeof MUST_PASS];
    expect(baselineProblems(readFileSync(`${DIR}/${file}`, 'utf8'), mustPass)).toEqual([]);
  });

  it('NFR-16 refuses an entry without a reason', () => {
    expect(baselineProblems('server:\n  - prompts-list\n', [])).toEqual(['prompts-list: needs exactly one line with a reason comment', 'every list line must be one entry with a reason']);
  });

  it('NFR-16 refuses a must-pass scenario baselined as a whole', () => {
    expect(baselineProblems('server:\n  - caching # why\n', ['caching'])).toEqual(['caching: a must-pass scenario cannot be baselined as a whole']);
  });

  it('NFR-16 accepts a single reasoned check of a must-pass scenario', () => {
    expect(baselineProblems('server:\n  - caching:sep-2549-prompts-list-caching-hints # prompts are not offered\n', ['caching'])).toEqual([]);
  });

  it('NFR-16 refuses entries hidden from the line check (flow style)', () => {
    expect(baselineProblems('server: [prompts-list] # why\n', [])).toContain('prompts-list: needs exactly one line with a reason comment');
  });

  it('NFR-16 accepts the empty form and reasoned entries', () => {
    expect(baselineProblems('server: []\n', ['caching'])).toEqual([]);
    expect(baselineProblems('server:\n  - prompts-list # prompts are not offered\n', ['caching'])).toEqual([]);
  });
});
