/** Activities registered on the worker. Names and argument shapes are part of workflow history (ADR 0006). */
import type { ChangesetActivities } from '@aiops/temporal';
import type { echo } from './echo.js';

export { echo } from './echo.js';
export { createActivities, type ActivityDeps } from './changeset.js';
export { createExecutionGuard, type ExecutionGuardDeps } from './guard.js';
export { executionSettings, type ExecutionSettings } from './settings.js';

/** Every activity the worker registers: the smoke workflow's `echo` and the change-set activities. */
export type WorkerActivities = ChangesetActivities & { readonly echo: typeof echo };
