// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ChangesetActivities } from './contract.js';

describe('workflow contract', () => {
  it('EXE-10 the contract module has no runtime imports', () => {
    const source = readFileSync(new URL('./contract.ts', import.meta.url), 'utf8');
    const imports = source.split('\n').filter((line) => /^\s*(import|export)\b.*\bfrom\s/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^\s*(import|export) type\b/);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });

  it('EXE-8 the activity names are part of the contract', () => {
    // A key missing here or unknown to the interface fails the type-check; the sorted list pins the names.
    const names = {
      inspect: true,
      prepare: true,
      expire: true,
      beginExecution: true,
      executeBatch: true,
      finishExecution: true,
      openRollbackWindow: true,
      beginRollback: true,
      rollbackBatch: true,
      finishRollback: true,
    } satisfies Record<keyof ChangesetActivities, true>;
    expect(Object.keys(names).sort()).toEqual([
      'beginExecution',
      'beginRollback',
      'executeBatch',
      'expire',
      'finishExecution',
      'finishRollback',
      'inspect',
      'openRollbackWindow',
      'prepare',
      'rollbackBatch',
    ]);
  });
});
