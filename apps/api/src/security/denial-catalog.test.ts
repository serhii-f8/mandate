import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DenyReason } from '@aiops/core';
import { describe, expect, it } from 'vitest';
import { DENIAL_PATHS } from '../../test/security/denial-catalog.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// A new DenyReason or LimitName breaks compilation here until it is listed.
const DENY_REASONS = {
  no_grant: true,
  unknown_tool: true,
  scope_argument_missing: true,
  out_of_scope: true,
  denied_field: true,
  field_not_allowed: true,
  limit_exceeded: true,
} as const satisfies Record<DenyReason, true>;
const LIMITS = ['records_per_operation', 'records_per_day', 'concurrent_executions', 'calls_per_minute'] as const;
const REQUIREMENTS = ['MCP-3', 'POL-1', 'POL-2', 'POL-3', 'POL-4', 'POL-5', 'POL-6', 'POL-7', 'POL-8', 'SEC-10'] as const;

const codes = DENIAL_PATHS.map((p) => p.code);

describe('SEC-11 every SPEC 5.3 denial path has an entry and a test', () => {
  it('SEC-11 every DenyReason has an entry', () => {
    for (const reason of Object.keys(DENY_REASONS)) {
      expect(codes.some((c) => c === reason || c.startsWith(`${reason}/`)), reason).toBe(true);
    }
  });

  it('SEC-11 POL-4 every limit name has a limit_exceeded entry', () => {
    for (const limit of LIMITS) expect(codes, limit).toContain(`limit_exceeded/${limit}`);
  });

  it('SEC-11 POL-5 the start refusals not_approved and pending_approval have entries', () => {
    expect(codes).toContain('not_approved');
    expect(codes).toContain('pending_approval');
  });

  it('SEC-11 every POL-1..POL-8 and SEC-10 has at least one entry', () => {
    for (const req of REQUIREMENTS) expect(DENIAL_PATHS.some((p) => p.requirement === req), req).toBe(true);
  });

  it('SEC-11 entry ids are unique', () => {
    const ids = DENIAL_PATHS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('SEC-11 each entry names an existing test file that contains its title verbatim', () => {
    const missing = DENIAL_PATHS.filter((p) => {
      const file = resolve(root, p.test.file);
      return !existsSync(file) || !readFileSync(file, 'utf8').includes(p.test.title);
    }).map((p) => `${p.id}: ${p.test.file} :: ${p.test.title}`);
    expect(missing).toEqual([]);
  });
});
