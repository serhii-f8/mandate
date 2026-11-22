// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Answers about a change-set, shared by the write call, `get_changeset` and the Tasks
 * handlers so one state yields one answer (MCP-7, MCP-4). Counts and IDs only (SEC-5).
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  encodeCursor,
  preparationErrorResult,
  preparedResult,
  type ChangeSetKind,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type ChangeSetStats,
  type ChangeSetStatus,
  type InvocationResult,
} from '@mandate/core';

const FIRST_ITEMS = 20;

/** The prepared result: counts, hash and the first 20 items with the cursor for the rest. */
export async function preparedAnswer(repository: Pick<ChangeSetRepository, 'itemsPage'>, record: ChangeSetRecord, kind?: ChangeSetKind): Promise<InvocationResult> {
  const items = await repository.itemsPage(record.id, { limit: FIRST_ITEMS });
  const last = items.at(-1);
  const nextCursor = items.length === FIRST_ITEMS && record.stats.total > FIRST_ITEMS && last !== undefined ? encodeCursor(last.targetId) : undefined;
  return preparedResult(record, items, nextCursor, kind);
}

/** A change-set that failed, or was cancelled, while preparing. */
export function preparationErrorAnswer(record: ChangeSetRecord): InvocationResult {
  const code = record.status === 'cancelled' ? 'cancelled' : (record.errorCode ?? 'internal');
  return preparationErrorResult(record.operation, code, record.id, record.errorStatus);
}

export function expiredDuringPreparationAnswer(record: ChangeSetRecord): InvocationResult {
  // Named in the structured data, as a preparation error is, so the answer links its page (MCP-6).
  const structured = { changeset: { id: record.id, status: 'expired', errorCode: 'expired' } };
  return {
    text: `${record.operation} could not prepare a change-set: it expired before preparation finished (change-set ${record.id}).`,
    structured,
    dataText: JSON.stringify(structured),
    isError: true,
  };
}

export function preparingAnswer(id: string): InvocationResult {
  return {
    text: `Change-set ${id} is being prepared. Call get_changeset with this ID to see the result.`,
    structured: { changesetId: id, status: 'preparing' },
  };
}

export function executionSummaryText(status: ChangeSetStatus, stats: ChangeSetStats, drift: number): string {
  const v = stats.verification;
  // EXE-12: an item still pending counts as not confirmed.
  const verified = v === undefined ? '' : `; ${String(v.confirmed)} confirmed, ${String(v.unconfirmed + v.pending)} not confirmed`;
  return `${status}: ${String(stats.written)} written, ${String(stats.failed)} failed, ${String(stats.skipped)} skipped (${String(drift)} changed upstream since preparation)${verified}.`;
}

export function executionAnswer(record: ChangeSetRecord, errorCounts: Readonly<Record<string, number>>): InvocationResult {
  const drift = errorCounts.drift ?? 0;
  const { written, failed, skipped } = record.stats;
  return {
    text: executionSummaryText(record.status, record.stats, drift),
    structured: { changesetId: record.id, status: record.status, stats: { written, failed, skipped, drift, ...(record.stats.verification === undefined ? {} : { verification: record.stats.verification }) } },
    ...(record.status === 'failed' ? { isError: true } : {}),
  };
}

export function toCallToolResult(r: InvocationResult): CallToolResult {
  return {
    // MCP-4: summary first; the data again as JSON for clients that ignore structuredContent.
    content: [{ type: 'text', text: r.text }, ...(r.dataText === undefined ? [] : [{ type: 'text' as const, text: r.dataText }])],
    ...(r.structured === undefined ? {} : { structuredContent: { ...r.structured } }),
    ...(r.isError === true ? { isError: true } : {}),
  };
}
