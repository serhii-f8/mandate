// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { echo } from './echo.js';

describe('echo activity', () => {
  it('returns the message', async () => {
    expect(await echo('hi')).toBe('hi');
  });
});
