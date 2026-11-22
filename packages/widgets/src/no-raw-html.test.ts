// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('SEC-5 raw html', () => {
  it('SEC-5 no widgets source uses dangerouslySetInnerHTML or innerHTML', () => {
    const root = __dirname;
    // Split so this file does not match itself.
    const needles = ['dangerously' + 'SetInnerHTML', 'inner' + 'HTML'];
    const offenders = (readdirSync(root, { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('no-raw-html.test.ts'))
      .filter((f) => {
        const text = readFileSync(join(root, f), 'utf8');
        return needles.some((n) => text.includes(n));
      });
    expect(offenders).toEqual([]);
  });
});
