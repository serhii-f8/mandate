import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataConverter, Duration } from '@temporalio/common';
import { Worker, type NativeConnection, type WorkerOptions } from '@temporalio/worker';

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
  readonly activities: object;
  readonly dataConverter?: DataConverter;
  readonly shutdownGraceTime?: Duration;
  readonly shutdownForceTime?: Duration;
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
  });
}
