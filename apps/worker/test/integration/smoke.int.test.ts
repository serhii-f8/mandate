import { randomUUID } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorker } from '../../src/worker.js';
import type { smokeWorkflow } from '../../src/workflows/smoke.js';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
});

afterAll(async () => {
  await env.teardown();
});

describe('NFR-15 Temporal test environment', () => {
  it('runs smokeWorkflow to completion on a real worker', async () => {
    const taskQueue = `test-${randomUUID()}`;
    const worker = await createWorker({ connection: env.nativeConnection, namespace: 'default', taskQueue });
    const result = await worker.runUntil(
      env.client.workflow.execute<typeof smokeWorkflow>('smokeWorkflow', {
        args: [{ message: 'hi' }],
        taskQueue,
        workflowId: `smoke-${randomUUID()}`,
      }),
    );
    expect(result).toEqual({ echoed: 'hi' });
  });
});
