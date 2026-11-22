// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { clientDataConverter, parseTemporalKeys, workerDataConverter } from '@mandate/temporal';
import { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { echo } from '../../src/activities/index.js';
import { createWorker } from '../../src/worker.js';
import type { smokeWorkflow } from '../../src/workflows/smoke.js';
import { TEST_TEMPORAL_KEYS } from '../support/keys.js';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
});

afterAll(async () => {
  await env.teardown();
});

describe('NFR-15 Temporal test environment', () => {
  it('SEC-4 runs smokeWorkflow to completion on a real worker with the codec on both sides', async () => {
    const keys = parseTemporalKeys(TEST_TEMPORAL_KEYS);
    const client = new Client({ connection: env.connection, namespace: 'default', dataConverter: clientDataConverter(keys) });
    const taskQueue = `test-${randomUUID()}`;
    const worker = await createWorker({
      connection: env.nativeConnection,
      namespace: 'default',
      taskQueue,
      activities: { echo },
      dataConverter: workerDataConverter(keys),
    });
    const result = await worker.runUntil(
      client.workflow.execute<typeof smokeWorkflow>('smokeWorkflow', {
        args: [{ message: 'hi' }],
        taskQueue,
        workflowId: `smoke-${randomUUID()}`,
      }),
    );
    expect(result).toEqual({ echoed: 'hi' });
  });
});
