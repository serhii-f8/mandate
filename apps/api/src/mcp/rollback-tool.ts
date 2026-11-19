/**
 * `rollback_changeset` (MCP-8, EXE-8): tells the requester whether their executed change-set can be
 * rolled back now, and how many items it would restore until when. It never changes state: the
 * rollback itself is confirmed on the trusted page with a fresh login (SEC-8), so the answer links
 * there. Eligibility is the one function of `core` (design §2); answers and audit details carry IDs,
 * counts and codes only (SEC-3).
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createSchemaCompiler } from '@aiops/config';
import { rollbackEligibility, type ChangeSetRepository, type RollbackReason, type RollbackRefusal } from '@aiops/core';
import { pageLink } from '../changesets/links.js';
import { eligibilityDeps } from '../changesets/rollback.js';
import { notFound } from './changeset-tools.js';
import type { BuiltinTool } from './tool-catalog.js';

export const ROLLBACK_TOOL = 'rollback_changeset';

const ROLLBACK_SCHEMA = {
  type: 'object',
  properties: {
    changeset_id: { type: 'string', format: 'uuid' },
    hash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
  },
  required: ['changeset_id', 'hash'],
  additionalProperties: false,
} as const;

export interface RollbackToolDeps {
  readonly repository: ChangeSetRepository;
  readonly now: () => Date;
  /** `AIOPS_PUBLIC_URL`: base of the page link where the rollback is confirmed. */
  readonly publicUrl: URL;
}

const REASON_TEXT: Readonly<Record<RollbackReason, (id: string, status: string) => string>> = {
  already_rolled_back: (id) => `Change-set ${id} was already rolled back, or a rollback was requested.`,
  not_finished: (id, status) => `Change-set ${id} cannot be rolled back in status ${status}.`,
  strategy_none: (id) => `The operation of change-set ${id} does not allow rollback.`,
  window_closed: (id) => `The rollback window of change-set ${id} has closed.`,
  nothing_written: (id) => `Change-set ${id} wrote no item that can be rolled back.`,
};

/** The fixed answer of a refusal; `status` is the change-set's current one. */
function refusalText(id: string, r: RollbackRefusal, status: string): string {
  switch (r.refusal) {
    case 'not_found':
      return `Change-set ${id} was not found.`;
    case 'hash_mismatch':
      return 'The change-set changed; review it again.';
    case 'policy_denied':
      return 'You may no longer run this operation, so you cannot roll it back.';
    case 'not_rollbackable':
      return REASON_TEXT[r.reason](id, status);
  }
}

export function rollbackChangesetTool(deps: RollbackToolDeps): BuiltinTool {
  return {
    name: ROLLBACK_TOOL,
    description:
      'Check whether a change-set you executed can be rolled back, and how many items it would restore until when. Nothing is changed here: you confirm the rollback on the change-set page.',
    inputSchema: ROLLBACK_SCHEMA,
    widget: 'changeset',
    // It leads to a write the user confirms on the page, so clients must not treat it as a pure read.
    readOnlyHint: false,
    validate: createSchemaCompiler()(ROLLBACK_SCHEMA),
    async handler(args, { caller, snapshot, report }): Promise<CallToolResult> {
      // `validate` guarantees the shape.
      const id = args.changeset_id as string;
      const hash = args.hash as string;
      const e = await rollbackEligibility(eligibilityDeps(deps.repository, snapshot, deps.now), { changesetId: id, caller, hash });
      // Unknown and foreign change-sets answer alike, without a link (SEC-1).
      if (!e.ok && e.refusal === 'not_found') {
        report({ errorCode: e.refusal });
        return notFound(id);
      }
      // The caller's own change-set from here on; its current status for the answer. A record gone
      // meanwhile cannot happen (change-sets are never deleted); 'unknown' keeps the answer total.
      const status = (await deps.repository.get(id))?.status ?? 'unknown';
      if (!e.ok) {
        report({ errorCode: e.refusal });
        const reason = e.refusal === 'not_rollbackable' ? e.reason : e.refusal;
        // A refusal names the change-set, so the pipeline adds its page link (MCP-6).
        return {
          isError: true,
          content: [{ type: 'text', text: refusalText(id, e, status) }],
          structuredContent: { changesetId: id, rollback: { available: false, reason } },
        };
      }
      report({ changesetId: id, count: e.count });
      const until = e.until.toISOString();
      const pageUrl = pageLink(deps.publicUrl, id);
      return {
        content: [{ type: 'text', text: `Rollback of ${String(e.count)} item(s) of change-set ${id} is possible until ${until}. Confirm it on the page: ${pageUrl}` }],
        structuredContent: { changesetId: id, status, rollback: { available: true, count: e.count, until }, pageUrl },
      };
    },
  };
}
