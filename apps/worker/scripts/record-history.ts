/**
 * Records a workflow history fixture for the replay gate (ADR 0006):
 *   pnpm --filter @aiops/worker record-history
 * Runs smokeWorkflow on the Temporal test server with the CURRENT code and writes
 * test/workflow-histories/smokeWorkflow/completed.json. Never regenerate an existing
 * fixture to make a replay pass; add a new one for new code paths.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { echo } from '../src/activities/index.js';
import { createWorker } from '../src/worker.js';

const target = fileURLToPath(new URL('../test/workflow-histories/smokeWorkflow/completed.json', import.meta.url));
if (existsSync(target) && !process.argv.includes('--force')) {
  throw new Error(`${target} exists; fixtures are not regenerated (pass --force only when a patch is removed)`);
}

const env = await TestWorkflowEnvironment.createLocal();
try {
  const taskQueue = `record-${randomUUID()}`;
  const worker = await createWorker({ connection: env.nativeConnection, namespace: 'default', taskQueue, activities: { echo } });
  const workflowId = `smoke-fixture-${randomUUID()}`;
  await worker.runUntil(
    env.client.workflow.execute('smokeWorkflow', { args: [{ message: 'fixture' }], taskQueue, workflowId }),
  );
  const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
  writeFileSync(target, `${historyToJSON(history)}\n`);
  console.log(`wrote ${target}`);
} finally {
  await env.teardown();
}
