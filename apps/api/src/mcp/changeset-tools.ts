import type { CallToolResult } from '@modelcontextprotocol/server';
import { createSchemaCompiler } from '@aiops/config';
import {
  CANCELLABLE,
  READ_RESULT_TEXT,
  changesetTransitionEvent,
  decodeCursor,
  encodeCursor,
  isExpiryDue,
  type Caller,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type ItemStatus,
} from '@aiops/core';
import type { BuiltinTool } from './tool-catalog.js';

export interface ChangesetToolDeps {
  readonly repository: ChangeSetRepository;
  readonly newId: () => string;
  readonly now: () => Date;
}

const DEFAULT_PAGE_SIZE = 50;

const GET_SCHEMA = {
  type: 'object',
  properties: {
    changeset_id: { type: 'string', format: 'uuid' },
    cursor: { type: 'string', maxLength: 512 },
    page_size: { type: 'integer', minimum: 1, maximum: 100 },
    status: { enum: ['pending', 'excluded', 'written', 'failed', 'skipped'] },
  },
  required: ['changeset_id'],
  additionalProperties: false,
} as const;

const CANCEL_SCHEMA = {
  type: 'object',
  properties: { changeset_id: { type: 'string', format: 'uuid' } },
  required: ['changeset_id'],
  additionalProperties: false,
} as const;

const compile = createSchemaCompiler();

const error = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });
const notFound = (id: string): CallToolResult => error(`Change-set ${id} was not found.`);

/** The change-set when the caller requested it; unknown and foreign IDs look the same. Expires it lazily (CS-6). */
async function load(deps: ChangesetToolDeps, caller: Caller, correlationId: string, id: string): Promise<ChangeSetRecord | undefined> {
  let record = await deps.repository.get(id);
  if (record?.requester !== caller.subject) return undefined;
  const now = deps.now();
  if (isExpiryDue(record, now)) {
    await deps.repository.transition(
      id,
      [record.status],
      'expired',
      changesetTransitionEvent({ id: deps.newId(), actor: 'system', changeset: record, from: record.status, to: 'expired', correlationId }),
      { expiredBefore: now },
    );
    // A miss means someone else moved it first; either way the current state is the answer.
    record = await deps.repository.get(id);
  }
  return record;
}

function getChangeset(deps: ChangesetToolDeps): BuiltinTool {
  return {
    name: 'get_changeset',
    description: 'Show a change-set you prepared: its status, counts and one page of items.',
    inputSchema: GET_SCHEMA,
    validate: compile(GET_SCHEMA),
    async handler(args, { caller, correlationId }) {
      // `validate` guarantees the shape.
      const id = args.changeset_id as string;
      let after: string | undefined;
      if (typeof args.cursor === 'string') {
        after = decodeCursor(args.cursor);
        if (after === undefined) return error('Input validation error: Invalid arguments for tool get_changeset: cursor is not valid');
      }
      const record = await load(deps, caller, correlationId, id);
      if (record === undefined) return notFound(id);
      const limit = typeof args.page_size === 'number' ? args.page_size : DEFAULT_PAGE_SIZE;
      // One more than asked tells whether another page follows.
      const rows = await deps.repository.itemsPage(id, {
        limit: limit + 1,
        ...(after === undefined ? {} : { after }),
        ...(typeof args.status === 'string' ? { status: args.status as ItemStatus } : {}),
      });
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const nextCursor = rows.length > limit && last !== undefined ? encodeCursor(last.targetId) : undefined;
      const excluded = Object.values(record.stats.excluded).reduce((sum, n) => sum + n, 0);
      const structured: Record<string, unknown> = {
        changeset: {
          id: record.id,
          operation: record.operation,
          status: record.status,
          ...(record.hash === undefined ? {} : { hash: record.hash }),
          stats: record.stats,
          createdAt: record.createdAt.toISOString(),
          expiresAt: record.expiresAt.toISOString(),
          ...(record.preparedAt === undefined ? {} : { preparedAt: record.preparedAt.toISOString() }),
          ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
        },
        items,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
      const text =
        `Change-set ${record.id} (${record.operation}) is ${record.status}: ${String(record.stats.included)} change(s), ` +
        `${String(excluded)} excluded. Showing ${String(items.length)} item(s)${nextCursor === undefined ? '' : '; more with cursor'}. ${READ_RESULT_TEXT.dataNote}`;
      return { content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
    },
  };
}

function cancelChangeset(deps: ChangesetToolDeps): BuiltinTool {
  return {
    name: 'cancel_changeset',
    description: 'Cancel a change-set you prepared, before it is executed.',
    inputSchema: CANCEL_SCHEMA,
    // It changes a change-set's status, so clients must not treat it as a pure read.
    readOnlyHint: false,
    validate: compile(CANCEL_SCHEMA),
    async handler(args, { caller, correlationId }) {
      // `validate` guarantees the shape.
      const id = args.changeset_id as string;
      const record = await load(deps, caller, correlationId, id);
      if (record === undefined) return notFound(id);
      let current = record;
      if (CANCELLABLE.includes(record.status)) {
        const done = await deps.repository.transition(
          id,
          CANCELLABLE,
          'cancelled',
          changesetTransitionEvent({
            id: deps.newId(),
            actor: caller.subject,
            ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
            changeset: record,
            from: record.status,
            to: 'cancelled',
            correlationId,
          }),
        );
        if (done !== undefined) {
          return { content: [{ type: 'text', text: `Change-set ${id} was cancelled.` }], structuredContent: { changeset: { id, status: done.status } } };
        }
        // Lost a race: answer with what the change-set is now.
        current = (await deps.repository.get(id)) ?? record;
      }
      return error(`Change-set ${id} cannot be cancelled in status ${current.status}.`);
    },
  };
}

export function createChangesetTools(deps: ChangesetToolDeps): readonly BuiltinTool[] {
  return [getChangeset(deps), cancelChangeset(deps)];
}
