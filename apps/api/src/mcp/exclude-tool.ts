// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * `exclude_changeset_items` (CS-5, MCP-8): the requester removes items from a prepared change-set, or
 * puts back items they removed, before submitting it. The answer is a new change-set with its own ID
 * and hash; the source is never changed. Answers and audit details carry IDs and counts only (SEC-3).
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createSchemaCompiler } from '@mandate/config';
import { CHANGESET_TEXT, READ_RESULT_TEXT, type DeriveRefusal } from '@mandate/core';
import { excludableIn, excludeItems, type ExclusionDeps } from '../changesets/exclusions.js';
import { preparedAnswer, toCallToolResult } from '../changesets/results.js';
import { notFound } from './changeset-tools.js';
import type { BuiltinTool } from './tool-catalog.js';

export const EXCLUDE_TOOL = 'exclude_changeset_items';

const TARGETS = { type: 'array', maxItems: 1000, items: { type: 'string', minLength: 1, maxLength: 512 } } as const;

const EXCLUDE_SCHEMA = {
  type: 'object',
  properties: {
    changeset_id: { type: 'string', format: 'uuid' },
    hash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    exclude: TARGETS,
    include: TARGETS,
  },
  required: ['changeset_id', 'hash'],
  additionalProperties: false,
} as const;

/** The fixed answer and audit code of a refusal; an already expired source reads as expired (as `decide`). */
function refusal(id: string, r: DeriveRefusal): { code: string; result: CallToolResult } {
  // Every refusal but not_found comes after the requester check, so it names the caller's own
  // change-set and gets its page link (MCP-6).
  const error = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }], structuredContent: { changesetId: id } });
  switch (r.reason) {
    case 'not_found':
      return { code: r.reason, result: notFound(id) };
    case 'not_prepared':
      if (r.status === 'expired') return { code: 'expired', result: error(`Change-set ${id} has expired.`) };
      return { code: r.reason, result: error(`Change-set ${id} cannot be edited in status ${r.status}.`) };
    case 'expired':
      return { code: r.reason, result: error(`Change-set ${id} has expired.`) };
    case 'hash_mismatch':
      return { code: r.reason, result: error('The change-set changed; review it again.') };
    case 'invalid_request':
      return { code: r.reason, result: error('At most 1000 target IDs per call, each 1 to 512 characters without control characters.') };
    case 'empty_request':
      return { code: r.reason, result: error('Name at least one item to exclude or include.') };
    case 'unknown_items':
      return {
        code: r.reason,
        result: error(`${String(r.count)} of the named items cannot be changed: exclude only included items, include only items you excluded.`),
      };
    case 'not_excludable':
      return { code: r.reason, result: error(`Change-set ${id} is a single upstream call; it has no items to exclude.`) };
    case 'nothing_left':
      return { code: r.reason, result: error('Excluding these items would leave nothing to change.') };
  }
}

export function excludeChangesetItemsTool(deps: ExclusionDeps): BuiltinTool {
  return {
    name: EXCLUDE_TOOL,
    description:
      'Remove items from a change-set you prepared (or put back items you removed) before submitting it: this creates a new change-set with its own ID and hash; the original stays unchanged.',
    inputSchema: EXCLUDE_SCHEMA,
    widget: 'changeset',
    // It creates a change-set, so clients must not treat it as a pure read.
    readOnlyHint: false,
    validate: createSchemaCompiler()(EXCLUDE_SCHEMA),
    async handler(args, { caller, correlationId, report, snapshot }): Promise<CallToolResult> {
      // `validate` guarantees the shape.
      const sourceId = args.changeset_id as string;
      const exclude = (args.exclude as string[] | undefined) ?? [];
      const include = (args.include as string[] | undefined) ?? [];
      const outcome = await excludeItems(deps, {
        sourceId,
        hash: args.hash as string,
        exclude,
        include,
        caller,
        correlationId,
        excludable: excludableIn(snapshot),
      });
      if (!outcome.ok) {
        const { code, result } = refusal(sourceId, outcome);
        report({ errorCode: code });
        return result;
      }
      const { changeset, excludedByRequester } = outcome;
      report({ changesetId: changeset.id, derivedFrom: sourceId, excludeCount: exclude.length, includeCount: include.length });
      const structured = { ...(await preparedAnswer(deps.repository, changeset)).structured, derivedFrom: sourceId };
      const excludedTotal = Object.values(changeset.stats.excluded).reduce((sum, n) => sum + n, 0);
      const text =
        `Change-set ${changeset.id} replaces ${sourceId} for your submission: ${String(changeset.stats.included)} change(s), ` +
        `${String(excludedTotal)} excluded (${String(excludedByRequester)} by you). New hash ${changeset.hash ?? ''}; ` +
        `expires ${changeset.expiresAt.toISOString()}. ${CHANGESET_TEXT.nothingWritten} ${CHANGESET_TEXT.seeAll} ${READ_RESULT_TEXT.dataNote}`;
      // MCP-4: summary first, then the final structured data as JSON (ruling F15).
      return toCallToolResult({ text, structured, dataText: JSON.stringify(structured) });
    },
  };
}
