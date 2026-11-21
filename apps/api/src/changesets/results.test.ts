// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { EMPTY_STATS, encodeCursor, type ChangeSetRecord } from '@aiops/core';
import { executionAnswer, preparedAnswer, executionSummaryText, expiredDuringPreparationAnswer, preparationErrorAnswer, preparingAnswer, toCallToolResult } from './results.js';

const stats = { ...EMPTY_STATS, total: 3, included: 3, written: 2, failed: 0, skipped: 1 };

function record(status: ChangeSetRecord['status'], extra: Partial<ChangeSetRecord> = {}): ChangeSetRecord {
  return {
    id: 'cs-1',
    operation: 'magento.update',
    connection: 'c',
    requester: 'alice',
    args: {},
    status,
    stats,
    configHash: 'h',
    correlationId: 'corr',
    createdAt: new Date(0),
    expiresAt: new Date(1),
    approvalRound: 0,
    ...extra,
  };
}

describe('change-set answers', () => {
  it('MCP-7 MCP-4 preparedAnswer takes 20 items and sets the next cursor only for more', async () => {
    const item = (n: number) => ({ targetId: `t${String(n)}`, status: 'pending' as const, before: null, after: null });
    const calls: unknown[] = [];
    const repo = {
      itemsPage: (_id: string, q: unknown) => {
        calls.push(q);
        return Promise.resolve(Array.from({ length: 20 }, (_v, i) => item(i)));
      },
    };
    const more = await preparedAnswer(repo, record('prepared', { stats: { ...stats, total: 25 } }));
    expect(calls).toEqual([{ limit: 20 }]);
    expect(more.structured).toHaveProperty('nextCursor', encodeCursor('t19'));
    const exact = await preparedAnswer(repo, record('prepared', { stats: { ...stats, total: 20 } }));
    expect(exact.structured).not.toHaveProperty('nextCursor');
  });

  it('SEC-5 CS-7 executionSummaryText counts only', () => {
    expect(executionSummaryText('completed_with_errors', stats, 1)).toBe(
      'completed_with_errors: 2 written, 0 failed, 1 skipped (1 changed upstream since preparation).',
    );
  });

  it('MCP-7 preparingAnswer text', () => {
    expect(preparingAnswer('cs-1')).toEqual({
      text: 'Change-set cs-1 is being prepared. Call get_changeset with this ID to see the result.',
      structured: { changesetId: 'cs-1', status: 'preparing' },
    });
  });

  it('MCP-7 executionAnswer marks failed as error', () => {
    const failed = executionAnswer(record('failed'), { drift: 1 });
    expect(failed.isError).toBe(true);
    expect(failed.structured).toEqual({ changesetId: 'cs-1', status: 'failed', stats: { written: 2, failed: 0, skipped: 1, drift: 1 } });
    expect(executionAnswer(record('completed'), {}).isError).toBeUndefined();
  });

  it('MCP-7 preparation errors and expiry', () => {
    expect(preparationErrorAnswer(record('failed', { errorCode: 'targets_missing' })).isError).toBe(true);
    expect(preparationErrorAnswer(record('cancelled')).structured).toMatchObject({ changeset: { status: 'cancelled', errorCode: 'cancelled' } });
    expect(expiredDuringPreparationAnswer(record('expired'))).toMatchObject({
      text: 'magento.update could not prepare a change-set: it expired before preparation finished (change-set cs-1).',
      isError: true,
    });
  });

  it('MCP-6 expired during preparation names the change-set in structured data', () => {
    const structured = { changeset: { id: 'cs-1', status: 'expired', errorCode: 'expired' } };
    expect(expiredDuringPreparationAnswer(record('expired'))).toEqual({
      text: 'magento.update could not prepare a change-set: it expired before preparation finished (change-set cs-1).',
      structured,
      dataText: JSON.stringify(structured),
      isError: true,
    });
  });

  it('MCP-7 toCallToolResult maps text, data text, structured and error flag', () => {
    expect(toCallToolResult({ text: 'a', dataText: 'b', structured: { x: 1 }, isError: true })).toEqual({
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
      structuredContent: { x: 1 },
      isError: true,
    });
    expect(toCallToolResult({ text: 'a' })).toEqual({ content: [{ type: 'text', text: 'a' }] });
  });
});
