// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { LoadedConfiguration } from '@mandate/config';
import {
  hashStoredItems,
  type ChangeItemRecord,
  type ChangeSetRecord,
  type ChangeSetRepository,
  type HashVersion,
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

function beginRollback(changeset: ChangeSetRecord): Promise<unknown> {
  const repository = {
    get: () => Promise.resolve(changeset),
    itemsPage: () => Promise.resolve(ITEMS),
  } as Partial<ChangeSetRepository> as ChangeSetRepository; // beginRollback reads only these two before its answer
  const activities = createActivities({
    repository,
    configuration: () => ({}) as LoadedConfiguration, // only handed to rollbackWriterFor, which ignores it
    writerFor: () => {
      throw new Error('not used');
    },
    // No rollback writer: a change-set whose hash matches answers executor_error, a mismatch hash_mismatch.
    rollbackWriterFor: () => undefined,
    readerFor: () => {
      throw new Error('not used');
    },
    guardFor: () => {
      throw new Error('not used');
    },
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
