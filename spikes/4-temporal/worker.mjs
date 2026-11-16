// One worker process. VARIANT selects the workflow code: v1 | v2-unsafe | v2-patched.
import { Worker, NativeConnection } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import * as activities from './activities.mjs';

const variant = process.env.VARIANT;
if (!['v1', 'v2-unsafe', 'v2-patched'].includes(variant)) throw new Error(`bad VARIANT ${variant}`);
const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:4233' });
const worker = await Worker.create({
  connection,
  taskQueue: process.env.TASK_QUEUE ?? 'spike4',
  workflowsPath: fileURLToPath(new URL(`./workflows-${variant}.ts`, import.meta.url)),
  activities,
  // Worker Versioning experiment (Step 6): opt in only when BUILD_ID is set.
  ...(process.env.BUILD_ID
    ? { workerDeploymentOptions: { useWorkerVersioning: true, defaultVersioningBehavior: process.env.BEHAVIOR ?? 'PINNED',
        version: { deploymentName: 'spike4-dep', buildId: process.env.BUILD_ID } } }
    : {}),
});
console.log(`READY ${variant} pid=${process.pid}`);
await worker.run(); // resolves on SIGINT/SIGTERM after graceful shutdown
console.log(`STOPPED ${variant}`);
