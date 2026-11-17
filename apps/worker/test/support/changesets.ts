/** Change-sets in a chosen state, written through the repository port as the api would. */
import { randomUUID } from 'node:crypto';
import {
  changesetTransitionEvent,
  hashStoredItems,
  startEventFactory,
  type ChangeItemRecord,
  type ChangeSetRecord,
  type ChangeSetRepository,
} from '@aiops/core';
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
  /** Moves the change-set to `executing` with this execution request. */
  readonly execute?: { readonly actor?: string; readonly groups?: readonly string[]; readonly correlationId?: string; readonly clientId?: string };
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
  await repository.appendItems(created.id, targetIds(items).map(pendingItem));
  const hash = opts.hash ?? (await hashStoredItems(repository, created));
  const prepared = await repository.completePreparation(
    created.id,
    { status: 'prepared', hash, stats: await repository.stats(created.id), preparedAt: new Date() },
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

  const actor = opts.execute.actor ?? created.requester;
  const groups = opts.execute.groups ?? [EDITOR_GROUP];
  const correlationId = opts.execute.correlationId ?? 'corr-execute';
  const clientId = opts.execute.clientId === undefined ? {} : { clientId: opts.execute.clientId };
  const started = await repository.startExecution({
    changesetId: created.id,
    expectedHash: hash,
    request: { actor, groups, ...clientId, correlationId },
    now: new Date(),
    event: startEventFactory({ newId: randomUUID, actor, groups, ...clientId, correlationId }),
  });
  if (!started.ok) throw new Error(`test change-set not started: ${started.reason}`);
  return started.changeset;
}
