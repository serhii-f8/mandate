// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { READ_RESULT_TEXT } from '../read-result.js';
import type { ChangeItemRecord, ChangeSetRecord } from './model.js';
import { CHANGESET_TEXT, decodeCursor, encodeCursor, preparationErrorResult, preparedResult } from './result.js';

const record: ChangeSetRecord = {
  id: 'cs-1',
  operation: 'catalog.update_content',
  connection: 'magento',
  requester: 'alice',
  args: { brand: 'acme', skus: ['A', 'B', 'C', 'D'], changes: { description: 'SECRET-VALUE' } },
  hash: 'sha256:abc',
  status: 'prepared',
  stats: { total: 4, included: 3, excluded: { not_found: 1 }, written: 0, failed: 0, skipped: 0 },
  configHash: 'cfg',
  correlationId: 'corr',
  createdAt: new Date('2026-11-17T10:00:00.000Z'),
  preparedAt: new Date('2026-11-17T10:00:01.000Z'),
  expiresAt: new Date('2026-11-20T10:00:00.000Z'),
  approvalRound: 0,
};

const items: ChangeItemRecord[] = Array.from({ length: 25 }, (_, i) => ({
  targetId: `T${String(i).padStart(2, '0')}`,
  status: 'pending',
  before: { description: 'OLD-VALUE' },
  after: { description: 'SECRET-VALUE' },
}));

describe('MCP-4 SEC-5 prepared result', () => {
  it('MCP-4 text is the fixed sentence built from counts only', () => {
    const r = preparedResult(record, items.slice(0, 20), 'cursor-1');
    expect(r.text).toBe(
      'catalog.update_content prepared change-set cs-1: 3 change(s) to apply, 1 excluded (not_found 1). ' +
        'Nothing was written upstream. Hash sha256:abc; expires 2026-11-20T10:00:00.000Z. ' +
        `Use get_changeset to see every item. ${READ_RESULT_TEXT.dataNote}`,
    );
    expect(r.text).not.toContain('SECRET-VALUE');
    expect(r.text).not.toContain('OLD-VALUE');
    expect(r.isError).toBeUndefined();
  });

  it('MCP-4 omits the reason list when nothing is excluded and lists reasons in fixed order', () => {
    const none = preparedResult({ ...record, stats: { ...record.stats, excluded: {} } }, []);
    expect(none.text).toContain(': 3 change(s) to apply, 0 excluded. Nothing');
    const many = preparedResult(
      { ...record, stats: { ...record.stats, excluded: { no_change: 2, not_found: 1, missing_data: 3, out_of_scope: 4 } } },
      [],
    );
    expect(many.text).toContain('10 excluded (not_found 1, out_of_scope 4, missing_data 3, no_change 2).');
  });

  it('CS-5 the prepared text lists requester exclusions after no_change', () => {
    const r = preparedResult({ ...record, stats: { ...record.stats, excluded: { no_change: 1, requester: 2 } } }, []);
    expect(r.text).toContain('3 excluded (no_change 1, requester 2).');
  });

  it('MCP-4 structured content carries the change-set summary, at most 20 items and the cursor; dataText repeats it', () => {
    const r = preparedResult(record, items, 'cursor-1');
    const s = r.structured as { changeset: Record<string, unknown>; items: unknown[]; nextCursor?: string };
    expect(s.changeset).toEqual({
      id: 'cs-1',
      operation: 'catalog.update_content',
      kind: 'diff',
      status: 'prepared',
      hash: 'sha256:abc',
      stats: record.stats,
      createdAt: '2026-11-17T10:00:00.000Z',
      expiresAt: '2026-11-20T10:00:00.000Z',
    });
    expect(s.items.length).toBeLessThanOrEqual(20);
    expect(s.nextCursor).toBe('cursor-1');
    expect(r.dataText).toBe(JSON.stringify(r.structured));
    expect('nextCursor' in (preparedResult(record, []).structured ?? {})).toBe(false);
  });
});

describe('APR-5 prepared result kind', () => {
  it('APR-5 an opaque prepared result carries kind and the stored args; a diff one carries no args', () => {
    const opaque = preparedResult(record, items.slice(0, 1), undefined, 'opaque');
    const s = opaque.structured as { changeset: Record<string, unknown> };
    expect(s.changeset.kind).toBe('opaque');
    expect(s.changeset.args).toEqual(record.args);
    expect(opaque.dataText).toBe(JSON.stringify(opaque.structured));
    // The text stays counts only (SEC-5).
    expect(opaque.text).not.toContain('SECRET-VALUE');
    const diff = preparedResult(record, [], undefined, 'diff').structured as { changeset: Record<string, unknown> };
    expect(diff.changeset.kind).toBe('diff');
    expect('args' in diff.changeset).toBe(false);
  });
});

describe('SEC-3 preparation error results', () => {
  it('SEC-3 fixed value-free texts per code with the change-set id', () => {
    const op = 'catalog.update_content';
    expect(preparationErrorResult(op, 'targets_missing')).toEqual({
      text: CHANGESET_TEXT.errors.targets_missing(op),
      isError: true,
    });
    expect(preparationErrorResult(op, 'too_many_targets', 'cs-1').text).toBe(
      `${CHANGESET_TEXT.errors.too_many_targets(op).slice(0, -1)} (change-set cs-1).`,
    );
    for (const code of ['incomplete_read', 'cancelled'] as const) {
      expect(preparationErrorResult(op, code, 'cs-1')).toMatchObject({
        text: `${CHANGESET_TEXT.errors[code](op).slice(0, -1)} (change-set cs-1).`,
        isError: true,
      });
    }
    expect(preparationErrorResult(op, 'internal', 'cs-1')).toMatchObject({
      text: `${op} could not be prepared because of an internal error (change-set cs-1).`,
      isError: true,
    });
    expect(preparationErrorResult(op, 'timeout', 'cs-1').text).toBe(
      `${READ_RESULT_TEXT.errors.timeout(op).slice(0, -1)} (change-set cs-1).`,
    );
    expect(preparationErrorResult(op, 'something_else').text).toBe(READ_RESULT_TEXT.unknown(op));
  });

  it('SEC-3 EXE-4 execution-era failure codes have fixed value-free texts', () => {
    const op = 'catalog.update_content';
    const codes = [
      'config_changed',
      'preparation_interrupted',
      'operation_unavailable',
      'executor_error',
      'executor_unavailable',
      'workflow_closed',
    ] as const;
    for (const code of codes) {
      const base = CHANGESET_TEXT.errors[code](op);
      expect(base).toContain(op);
      expect(base).not.toBe(READ_RESULT_TEXT.unknown(op));
      expect(preparationErrorResult(op, code, 'cs-1')).toMatchObject({
        text: `${base.replace(/\.$/, '')} (change-set cs-1).`,
        isError: true,
      });
    }
    expect(CHANGESET_TEXT.errors.executor_unavailable(op)).toBe(
      `${op} could not be prepared: the execution service is unavailable.`,
    );
  });

  it('MCP-4 SEC-3 a failure with a change-set carries its id, status and code as structured data, nothing else', () => {
    const op = 'catalog.update_content';
    const failed = preparationErrorResult(op, 'http_status', 'cs-1', 404);
    expect(failed.text).toBe(`${op} failed: the upstream system answered HTTP 404 (change-set cs-1).`);
    expect(failed.structured).toEqual({ changeset: { id: 'cs-1', status: 'failed', errorCode: 'http_status' } });
    expect(failed.dataText).toBe(JSON.stringify(failed.structured));
    expect(failed.isError).toBe(true);
    expect(preparationErrorResult(op, 'cancelled', 'cs-2').structured).toEqual({
      changeset: { id: 'cs-2', status: 'cancelled', errorCode: 'cancelled' },
    });
    const none = preparationErrorResult(op, 'targets_missing');
    expect(none).not.toHaveProperty('structured');
    expect(none).not.toHaveProperty('dataText');
  });
});

describe('MCP-8 change-set item cursor', () => {
  it('MCP-8 round-trips target ids and rejects garbage', () => {
    for (const id of ['A', 'sku/with spaces', 'ünïcødé-😀']) {
      expect(decodeCursor(encodeCursor(id))).toBe(id);
    }
    expect(encodeCursor('sku/+?')).toMatch(/^[A-Za-z0-9_-]*$/);
    expect(decodeCursor('***')).toBeUndefined();
    expect(decodeCursor('QQ==')).toBeUndefined();
    expect(decodeCursor('QR')).toBeUndefined();
    expect(decodeCursor('')).toBeUndefined();
    expect(decodeCursor('_w')).toBeUndefined();
  });
});
