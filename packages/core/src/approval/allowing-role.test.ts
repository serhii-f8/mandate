// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { allowingRole } from './allowing-role.js';

describe('POL-4 allowing role', () => {
  it('names the role of a grant rule', () => {
    expect(allowingRole('role:content_manager/grant:own-brands')).toBe('content_manager');
  });
  it('has no role for the built-in rule', () => {
    expect(allowingRole('builtin')).toBeUndefined();
  });
  it('has no role for default-deny', () => {
    expect(allowingRole('default-deny')).toBeUndefined();
  });
});
