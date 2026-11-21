// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/**
 * Change-sets prepared by their own workflow, shared by the integration tests and the history
 * recorder (`scripts/record-history.ts`).
 */
import { randomUUID } from 'node:crypto';
import { createChangeSet, type ChangeSetRecord } from '@aiops/core';
import { PROGRESS_QUERY, type WorkflowProgress } from '@aiops/temporal';
import { submitChangeSet } from '@aiops/testing';
import { createPreparing } from './changesets.js';
import { APPROVING_GROUP, EDITOR_GROUP, WRITE_OPERATION } from './configuration.js';
import type { Infra, TestWorker } from './harness.js';

/**
 * Expiry, from creation, of change-sets that a case leaves to expire while it waits for an approval.
 * The time is real: preparation, submission and (in the returned case) return and resubmission must
 * fit before it. Measured here: a whole approved case (prepare, submit, approve, execute) takes
 * about 1 s, so the sequence fits well under 1 s; 10 s leaves room for a slow CI machine and keeps
 * each such case near 10.6 s. The committed fixtures were recorded with a 3 s window (replay does
 * not depend on it).
 */
export const SHORT_EXPIRY_MS = 10_000;

export interface CreatedOptions {
  /**
   * Stored as the change-set's expiry instead of `createdAt` plus one hour; the change-set is then
   * written through the repository (`createChangeSet` cannot expire sooner than a minute).
   */
  readonly expiresAt?: Date;
  /** The preparation's correlation ID (default `corr-create`); used on the `createChangeSet` path only. */
  readonly correlationId?: string;
}

/** Creates a change-set in `preparing` as the api does, under the current configuration's hash. */
export async function created(infra: Infra, skus: readonly string[], opts: CreatedOptions = {}): Promise<ChangeSetRecord> {
  const args = { brand: 'acme', skus, changes: { name: 'new' } };
  if (opts.expiresAt !== undefined) {
    return createPreparing(infra.repository, { args, configHash: infra.configuration.hash, expiresAt: opts.expiresAt });
  }
  const operation = infra.configuration.policy.operations.find((o) => o.id === WRITE_OPERATION);
  const manifest = operation?.manifest;
  if (operation === undefined || manifest === undefined) throw new Error('test operation missing');
  const result = await createChangeSet(
    { repository: infra.repository, newId: randomUUID, now: () => new Date() },
    {
      operation: { ...operation, manifest },
      args,
      caller: { subject: 'alice', groups: [EDITOR_GROUP] },
      correlationId: opts.correlationId ?? 'corr-create',
      configHash: infra.configuration.hash,
      expireAfterHours: 1,
    },
  );
  if (!result.ok) throw new Error(`change-set not created: ${result.code}`);
  return result.changeset;
}

export async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export const statusOf = async (infra: Infra, id: string): Promise<string | undefined> => (await infra.repository.get(id))?.status;

/** Waits until the change-set's workflow reports `status` through the progress query. */
export async function waitForWorkflowStatus(infra: Infra, id: string, status: string): Promise<void> {
  const handle = infra.client.workflow.getHandle(id);
  await waitFor(`workflow parked in ${status}`, async () => (await handle.query<WorkflowProgress>(PROGRESS_QUERY)).status === status);
}

/** Starts the workflow of a created change-set and waits until it has prepared it and parks. */
export async function preparedByWorkflow(
  infra: Infra,
  worker: TestWorker,
  skus: readonly string[],
  opts: CreatedOptions = {},
): Promise<ChangeSetRecord> {
  const cs = await created(infra, skus, opts);
  await worker.starter.start(cs.id);
  await waitFor('prepared', async () => (await statusOf(infra, cs.id)) === 'prepared');
  await waitForWorkflowStatus(infra, cs.id, 'prepared');
  const prepared = await infra.repository.get(cs.id);
  if (prepared === undefined) throw new Error('prepared change-set not found');
  return prepared;
}

/** Submits for the one `reviewer` step of `approving_editor` and wakes the waiting workflow. */
export async function submitted(infra: Infra, worker: TestWorker, cs: ChangeSetRecord): Promise<ChangeSetRecord> {
  const pending = await submitChangeSet(infra.repository, cs, { steps: ['reviewer'], groups: [APPROVING_GROUP] });
  await worker.executor.wake(cs.id);
  return pending;
}
