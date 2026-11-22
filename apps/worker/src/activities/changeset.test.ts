// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { LoadedConfiguration } from '@mandate/config';
import {
  hashStoredItems,
  type ChangeItemRecord,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type ChangeWriter,
  type HashVersion,
  type ManifestAction,
  type OperationDefinition,
  type RollbackStrategy,
} from '@mandate/core';
import { DEFAULT_TUNING } from '@mandate/temporal';
import { DefaultLogger } from '@temporalio/worker';
import { MockActivityEnvironment } from '@temporalio/testing';
import { createActivities } from './changeset.js';

const NOW = new Date('2026-11-22T10:00:00.000Z');
const ITEMS: readonly ChangeItemRecord[] = [{ targetId: 't-1', status: 'written', before: { name: 'old' }, after: { name: 'new' } }];

/** A change-set in rolling_back, sealed with `seal`, its hash computed from ITEMS under that seal. */
async function rollingBack(seal: Pick<ChangeSetRecord, 'hashVersion' | 'action'>): Promise<ChangeSetRecord> {
  const base = { id: 'cs-1', operation: 'catalog.update', args: { skus: ['t-1'] }, ...seal };
  const known = seal.hashVersion === 1 || seal.hashVersion === 2;
  return {
    ...base,
    connection: 'magento',
    requester: 'alice',
    hash: known ? await hashStoredItems({ itemsPage: () => Promise.resolve(ITEMS) }, base) : 'sha256:stored',
    status: 'rolling_back',
    stats: { total: 1, included: 1, excluded: {}, written: 1, skipped: 0, failed: 0 },
    configHash: 'h',
    correlationId: 'c',
    createdAt: NOW,
    expiresAt: NOW,
    approvalRound: 0,
  };
}

/** An operation as beginRollback reads it: its id, its manifest's action and rollback strategy. */
function op(id: string, action: ManifestAction, rollback: RollbackStrategy = { strategy: 'replay_previous_state' }): OperationDefinition {
  // beginRollback reads only `id` and `manifest.action` / `manifest.rollback` of an operation.
  return { id, manifest: { ...(action === 'update' ? {} : { action }), rollback } } as unknown as OperationDefinition;
}

/** A configuration holding only `operations`: beginRollback reads nothing else of it. */
function configurationOf(...operations: OperationDefinition[]): LoadedConfiguration {
  return { policy: { operations } } as unknown as LoadedConfiguration;
}

const UPDATE_CONFIGURATION = configurationOf(op('catalog.update', 'update'));
const A_WRITER: ChangeWriter = { writeBatch: () => Promise.reject(new Error('not used')) };

function beginRollback(
  changeset: ChangeSetRecord,
  configuration: LoadedConfiguration = UPDATE_CONFIGURATION,
  writer?: ChangeWriter,
): Promise<unknown> {
  const repository = {
    get: () => Promise.resolve(changeset),
    itemsPage: () => Promise.resolve(ITEMS),
    nextRollbackBatch: () => Promise.resolve(1),
  } as Partial<ChangeSetRepository> as ChangeSetRepository; // beginRollback reads only these three
  const activities = createActivities({
    repository,
    configuration: () => configuration,
    writerFor: () => {
      throw new Error('not used');
    },
    // Without a writer: a change-set whose hash matches answers executor_error, a mismatch hash_mismatch.
    rollbackWriterFor: () => writer,
    readerFor: () => {
      throw new Error('not used');
    },
    guardFor: () => {
      throw new Error('not used');
    },
    settingsFor: () => ({ batchSize: 100, failureThreshold: 0.5, itemsPerRun: 2000, rollbackWindowHours: 168 }),
    tuning: DEFAULT_TUNING,
    newId: () => 'id',
    now: () => NOW,
  });
  const env = new MockActivityEnvironment({ attempt: 1 }, { logger: new DefaultLogger('ERROR') });
  return env.run(() => activities.beginRollback(changeset.id));
}

describe('CS-4 EXE-8 beginRollback recomputes the hash with the stored version', () => {
  it('CS-4 a version 2 change-set passes the hash check, a version 1 hash under version 2 does not', async () => {
    const v2 = await rollingBack({ hashVersion: 2, action: 'update' });
    expect(await beginRollback(v2)).toEqual({ ok: false, outcome: 'executor_error' });
    const v1 = await rollingBack({ hashVersion: 1 });
    expect(await beginRollback(v1)).toEqual({ ok: false, outcome: 'executor_error' });
    expect(await beginRollback({ ...v2, hash: v1.hash ?? '' })).toEqual({ ok: false, outcome: 'hash_mismatch' });
  });

  it('CS-4 an unknown hash version is answered hash_mismatch', async () => {
    // A row from a newer release: the type does not admit 3, the database column does.
    const newer = await rollingBack({ hashVersion: 3 as HashVersion });
    expect(await beginRollback(newer)).toEqual({ ok: false, outcome: 'hash_mismatch' });
  });
});

describe('EXE-8 POL-6 beginRollback refuses a change-set whose action no longer matches', () => {
  const inverse = (operation: string): RollbackStrategy => ({ strategy: 'inverse_operation', operation });
  const READY = { ok: true, nextBatch: 1, itemsPerRun: 2000 };
  const REFUSED = { ok: false, outcome: 'executor_error' };

  it('EXE-8 a stored action equal to the operation\'s, with a matching inverse, starts the rollback', async () => {
    expect(await beginRollback(await rollingBack({ hashVersion: 2, action: 'update' }), UPDATE_CONFIGURATION, A_WRITER)).toEqual(READY);
    // A version 1 change-set has no action and counts as an update.
    expect(await beginRollback(await rollingBack({ hashVersion: 1 }), UPDATE_CONFIGURATION, A_WRITER)).toEqual(READY);
    const create = configurationOf(op('catalog.update', 'create', inverse('catalog.remove')), op('catalog.remove', 'delete', { strategy: 'none' }));
    expect(await beginRollback(await rollingBack({ hashVersion: 2, action: 'create' }), create, A_WRITER)).toEqual(READY);
    const del = configurationOf(op('catalog.update', 'delete', inverse('catalog.add')), op('catalog.add', 'create', { strategy: 'none' }));
    expect(await beginRollback(await rollingBack({ hashVersion: 2, action: 'delete' }), del, A_WRITER)).toEqual(READY);
    const update = configurationOf(op('catalog.update', 'update', inverse('catalog.revert')), op('catalog.revert', 'update'));
    expect(await beginRollback(await rollingBack({ hashVersion: 2, action: 'update' }), update, A_WRITER)).toEqual(READY);
  });

  it('EXE-8 a stored update under an operation that now creates is refused', async () => {
    const create = configurationOf(op('catalog.update', 'create', inverse('catalog.remove')), op('catalog.remove', 'delete'));
    expect(await beginRollback(await rollingBack({ hashVersion: 2, action: 'update' }), create, A_WRITER)).toEqual(REFUSED);
  });

  it('EXE-8 a copy without an action under an operation that now deletes is refused', async () => {
    const del = configurationOf(op('catalog.update', 'delete', inverse('catalog.add')), op('catalog.add', 'create'));
    expect(await beginRollback(await rollingBack({ hashVersion: 1 }), del, A_WRITER)).toEqual(REFUSED);
  });

  it('EXE-8 a stored create under an operation that is now an update is refused', async () => {
    expect(await beginRollback(await rollingBack({ hashVersion: 2, action: 'create' }), UPDATE_CONFIGURATION, A_WRITER)).toEqual(REFUSED);
  });

  it('EXE-8 a create whose inverse operation no longer deletes is refused', async () => {
    const create = configurationOf(op('catalog.update', 'create', inverse('catalog.remove')), op('catalog.remove', 'update'));
    expect(await beginRollback(await rollingBack({ hashVersion: 2, action: 'create' }), create, A_WRITER)).toEqual(REFUSED);
  });

  it('EXE-8 a delete whose inverse operation no longer creates is refused', async () => {
    const del = configurationOf(op('catalog.update', 'delete', inverse('catalog.add')), op('catalog.add', 'delete'));
    expect(await beginRollback(await rollingBack({ hashVersion: 2, action: 'delete' }), del, A_WRITER)).toEqual(REFUSED);
  });

  it('EXE-8 an update whose inverse operation now creates is refused', async () => {
    const update = configurationOf(op('catalog.update', 'update', inverse('catalog.revert')), op('catalog.revert', 'create'));
    expect(await beginRollback(await rollingBack({ hashVersion: 2, action: 'update' }), update, A_WRITER)).toEqual(REFUSED);
  });
});
