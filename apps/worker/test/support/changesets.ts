// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/** Change-sets in a chosen state, written through the repository port as the api would. */
import { randomUUID } from 'node:crypto';
import {
  changesetTransitionEvent,
  hashStoredItems,
  startEventFactory,
  type ChangeItemRecord,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type Submission,
} from '@mandate/core';
import { EDITOR_GROUP, WRITE_OPERATION } from './configuration.js';

export interface ChangeSetOptions {
  readonly operation?: string;
  readonly requester?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly configHash?: string;
  readonly correlationId?: string;
  readonly expiresAt?: Date;
}

export interface PreparedOptions extends ChangeSetOptions {
  /** Stored instead of the hash of the stored items (to provoke a mismatch). */
  readonly hash?: string;
  /** Builds the stored item of a target (default: `{ name }` before and after). */
  readonly itemFor?: (targetId: string) => ChangeItemRecord;
  /** Moves the change-set to `executing` with this execution request. */
  readonly execute?: ExecuteOptions;
}

/** Target IDs `t-0001`, `t-0002`, ... */
export function targetIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `t-${String(i + 1).padStart(4, '0')}`);
}

function pendingItem(targetId: string): ChangeItemRecord {
  return { targetId, status: 'pending', before: { name: `old ${targetId}` }, after: { name: 'new' } };
}

/** A change-set in `preparing`, as `createChangeSet` leaves it. */
export async function createPreparing(repository: ChangeSetRepository, opts: ChangeSetOptions = {}): Promise<ChangeSetRecord> {
  const id = randomUUID();
  const operation = opts.operation ?? WRITE_OPERATION;
  const requester = opts.requester ?? 'alice';
  const correlationId = opts.correlationId ?? 'corr-prepare';
  const createdAt = new Date();
  return repository.create(
    {
      id,
      operation,
      connection: 'magento',
      requester,
      args: opts.args ?? { brand: 'acme', changes: { name: 'new' } },
      configHash: opts.configHash ?? 'cfg',
      correlationId,
      createdAt,
      expiresAt: opts.expiresAt ?? new Date(createdAt.getTime() + 3_600_000),
    },
    changesetTransitionEvent({ id: randomUUID(), actor: requester, changeset: { id, operation }, from: null, to: 'preparing', correlationId }),
  );
}

/** A change-set with `items` pending items in `prepared` (or `executing` with `opts.execute`). */
export async function createPrepared(
  repository: ChangeSetRepository,
  items: number,
  opts: PreparedOptions = {},
): Promise<ChangeSetRecord> {
  const created = await createPreparing(repository, opts);
  await repository.appendItems(created.id, targetIds(items).map(opts.itemFor ?? pendingItem));
  const hash = opts.hash ?? (await hashStoredItems(repository, created));
  const prepared = await repository.completePreparation(
    created.id,
    { status: 'prepared', hashVersion: 1, hash, stats: await repository.stats(created.id), preparedAt: new Date() },
    changesetTransitionEvent({
      id: randomUUID(),
      actor: created.requester,
      changeset: created,
      from: 'preparing',
      to: 'prepared',
      correlationId: created.correlationId,
    }),
  );
  if (prepared === undefined) throw new Error('test change-set not prepared');
  if (opts.execute === undefined) return prepared;

  return startExecutionOf(repository, prepared, opts.execute);
}

export interface ExecuteOptions {
  readonly actor?: string;
  readonly groups?: readonly string[];
  readonly correlationId?: string;
  readonly clientId?: string;
  /** Stored as the change-set's submission, as a start without approval does (POL-6). */
  readonly submission?: Submission;
}

/** Moves a prepared change-set to `executing` with an execution request, as the executor's start does. */
export async function startExecutionOf(
  repository: ChangeSetRepository,
  prepared: ChangeSetRecord,
  execute: ExecuteOptions = {},
): Promise<ChangeSetRecord> {
  if (prepared.hash === undefined) throw new Error('test change-set has no hash');
  const actor = execute.actor ?? prepared.requester;
  const groups = execute.groups ?? [EDITOR_GROUP];
  const correlationId = execute.correlationId ?? 'corr-execute';
  const clientId = execute.clientId === undefined ? {} : { clientId: execute.clientId };
  const started = await repository.startExecution({
    changesetId: prepared.id,
    expectedHash: prepared.hash,
    request: { actor, groups, ...clientId, correlationId },
    ...(execute.submission === undefined ? {} : { submission: execute.submission }),
    now: new Date(),
    event: startEventFactory({ newId: randomUUID, actor, groups, ...clientId, correlationId }),
  });
  if (!started.ok) throw new Error(`test change-set not started: ${started.reason}`);
  return started.changeset;
}
