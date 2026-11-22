// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DenyReason, LimitName, StartRefusal } from '@mandate/core';
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
// calls_per_minute is enforced by the tool pipeline, not by a start, so it is not a core LimitName.
const LIMITS = {
  records_per_operation: true,
  records_per_day: true,
  concurrent_executions: true,
} as const satisfies Record<LimitName, true>;
const ALL_LIMITS = [...Object.keys(LIMITS), 'calls_per_minute'];
// true: a denial path of SPEC 5.3 that needs an entry; false: a start refusal that is not a policy denial.
const START_REFUSALS = {
  not_found: false,
  hash_mismatch: false,
  expired: false,
  not_executable: false,
  limit_exceeded: true,
  not_approved: true,
} as const satisfies Record<StartRefusal, boolean>;
const REQUIREMENTS = ['MCP-3', 'POL-1', 'POL-2', 'POL-3', 'POL-4', 'POL-5', 'POL-6', 'POL-7', 'POL-8', 'SEC-10'] as const;

const codes = DENIAL_PATHS.map((p) => p.code);

describe('SEC-11 every SPEC 5.3 denial path has an entry and a test', () => {
  it('SEC-11 every DenyReason has an entry', () => {
    for (const reason of Object.keys(DENY_REASONS)) {
      expect(codes.some((c) => c === reason || c.startsWith(`${reason}/`)), reason).toBe(true);
    }
  });

  it('SEC-11 POL-4 every limit name has a limit_exceeded entry', () => {
    for (const limit of ALL_LIMITS) expect(codes, limit).toContain(`limit_exceeded/${limit}`);
  });

  it('SEC-11 POL-5 the start refusals not_approved and pending_approval have entries', () => {
    for (const [refusal, needsEntry] of Object.entries(START_REFUSALS)) {
      if (needsEntry) expect(codes.some((c) => c === refusal || c.startsWith(`${refusal}/`)), refusal).toBe(true);
    }
    // Not a StartRefusal: the submit answers `pending_approval` instead of starting.
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
      if (!existsSync(file)) return true;
      // A test-title call: it( or test(, then the quoted title.
      const title = p.test.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return !new RegExp(`\\b(?:it|test)(?:\\.each\\([^)]*\\))?\\(\\s*(['"\`])${title}\\1`).test(readFileSync(file, 'utf8'));
    }).map((p) => `${p.id}: ${p.test.file} :: ${p.test.title}`);
    expect(missing).toEqual([]);
  });
});
