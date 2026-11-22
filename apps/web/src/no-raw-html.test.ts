// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('SEC-5 raw html', () => {
  it('SEC-5 no web source uses dangerouslySetInnerHTML', () => {
    const root = __dirname;
    const needle = 'dangerously' + 'SetInnerHTML';
    const offenders = (readdirSync(root, { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('no-raw-html.test.ts'))
      .filter((f) => readFileSync(join(root, f), 'utf8').includes(needle));
    expect(offenders).toEqual([]);
  });
});
