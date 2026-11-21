// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseTemporalKeys, workerDataConverter } from '@aiops/temporal';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { echo } from '../../src/activities/index.js';
import { createWorker } from '../../src/worker.js';
import { quietTemporalLogs } from '../support/harness.js';
import { TEST_TEMPORAL_KEYS } from '../support/keys.js';

const run = promisify(execFile);
const workerDir = fileURLToPath(new URL('../../', import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  quietTemporalLogs();
  env = await TestWorkflowEnvironment.createLocal();
});

afterAll(async () => {
  await env.teardown();
});

describe('SEC-4 smoke CLI', () => {
  it('SEC-4 the smoke CLI runs smokeWorkflow through the codec', async () => {
    const taskQueue = `test-${randomUUID()}`;
    // A worker that only accepts encrypted payloads: a plaintext start would fail to decode.
    const worker = await createWorker({
      connection: env.nativeConnection,
      namespace: 'default',
      taskQueue,
      activities: { echo },
      dataConverter: workerDataConverter(parseTemporalKeys(TEST_TEMPORAL_KEYS)),
    });
    const { stdout } = await worker.runUntil(
      run('pnpm', ['exec', 'tsx', '--conditions=@aiops/source', 'src/smoke-cli.ts', 'accept'], {
        cwd: workerDir,
        env: {
          ...process.env,
          TEMPORAL_ADDRESS: env.address,
          TEMPORAL_NAMESPACE: 'default',
          TEMPORAL_TASK_QUEUE: taskQueue,
          AIOPS_TEMPORAL_KEYS: TEST_TEMPORAL_KEYS,
          // The worker environment is parsed as a whole; the smoke CLI connects to neither.
          DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
          AIOPS_CONFIG_DIR: '/nonexistent',
          AIOPS_MASTER_KEYS: '1:unused',
        },
      }),
    );
    expect(stdout).toContain('"echoed":"accept"');
  });
});
