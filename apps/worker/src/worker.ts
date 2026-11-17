import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataConverter, Duration } from '@temporalio/common';
import { Worker, type NativeConnection, type WorkerOptions } from '@temporalio/worker';
import type { WorkerActivities } from './activities/index.js';

const sourceExtension = extname(fileURLToPath(import.meta.url));

/** Workflow entry module, `.ts` under tests and `.js` in the built image. */
export const workflowsPath = fileURLToPath(new URL(`./workflows/index${sourceExtension}`, import.meta.url));

/**
 * Bundler options for the workflow sandbox. Running from `.ts` (tests, scripts), webpack must
 * resolve workspace packages through the `@aiops/source` export condition, as Vitest does
 * (ADR 0010); otherwise `@aiops/temporal/contract` would come from a possibly stale `dist`.
 * `'...'` keeps webpack's default condition names (webpack 5 `resolve.conditionNames`). The
 * built image bundles from `dist` and keeps the defaults.
 */
export function workflowBundlerOptions(): NonNullable<WorkerOptions['bundlerOptions']> {
  if (sourceExtension !== '.ts') return {};
  return {
    webpackConfigHook: (config) => ({
      ...config,
      resolve: { ...config.resolve, conditionNames: ['@aiops/source', '...'] },
    }),
  };
}

export interface CreateWorkerOptions {
  readonly connection: NativeConnection;
  readonly namespace: string;
  readonly taskQueue: string;
  /** The runtime registers all of them; tests and the history recorder register the ones their workflows call. */
  readonly activities: Partial<WorkerActivities>;
  readonly dataConverter?: DataConverter;
  readonly shutdownGraceTime?: Duration;
  readonly shutdownForceTime?: Duration;
  /** Default: the SDK's. 0 keeps no workflow sticky to this worker (tests spread workflow tasks over workers). */
  readonly maxCachedWorkflows?: number;
  /** Default: the SDK's (`<pid>@<hostname>`); the history recorder sets a fixed one. */
  readonly identity?: string;
}

export function createWorker(options: CreateWorkerOptions): Promise<Worker> {
  return Worker.create({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    workflowsPath,
    bundlerOptions: workflowBundlerOptions(),
    activities: options.activities,
    ...(options.dataConverter === undefined ? {} : { dataConverter: options.dataConverter }),
    ...(options.shutdownGraceTime === undefined ? {} : { shutdownGraceTime: options.shutdownGraceTime }),
    ...(options.shutdownForceTime === undefined ? {} : { shutdownForceTime: options.shutdownForceTime }),
    ...(options.maxCachedWorkflows === undefined ? {} : { maxCachedWorkflows: options.maxCachedWorkflows }),
    ...(options.identity === undefined ? {} : { identity: options.identity }),
  });
}
