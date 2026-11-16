import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, type NativeConnection } from '@temporalio/worker';
import * as activities from './activities/index.js';

/** Workflow entry module, `.ts` under tests and `.js` in the built image. */
export const workflowsPath = fileURLToPath(
  new URL(`./workflows/index${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

export interface CreateWorkerOptions {
  readonly connection: NativeConnection;
  readonly namespace: string;
  readonly taskQueue: string;
}

export function createWorker(options: CreateWorkerOptions): Promise<Worker> {
  return Worker.create({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    workflowsPath,
    activities,
  });
}
