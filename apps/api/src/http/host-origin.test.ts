// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { hostAllowed, originAllowed } from './host-origin.js';

const allowed = ['localhost', '127.0.0.1', '::1'];

describe('Host and Origin validation (DNS rebinding protection, ADR 0013)', () => {
  it.each([
    ['localhost:8400', true],
    ['localhost', true],
    ['127.0.0.1:8400', true],
    ['[::1]:8400', true],
    ['evil.example', false],
    ['evil.example:8400', false],
    [undefined, false],
    ['', false],
  ])('Host %s → %s', (host, expected) => {
    expect(hostAllowed(host, allowed)).toBe(expected);
  });

  it.each([
    [undefined, true],
    ['http://localhost:3000', true],
    ['https://127.0.0.1', true],
    ['https://evil.example', false],
    ['null', false],
    ['not a url', false],
  ])('Origin %s → %s', (origin, expected) => {
    expect(originAllowed(origin, allowed)).toBe(expected);
  });
});
