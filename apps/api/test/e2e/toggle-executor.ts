import {
  ExecutorUnavailable,
  type ChangeSetExecutor,
  type RollbackRequestInput,
  type RollbackRequestOutcome,
  type StartOutcome,
  type StartRequest,
} from '@aiops/core';
import type { InMemoryExecutor } from '@aiops/testing';

/** Wraps the in-memory executor; a test can make starts refuse or the executor (starts and rollback requests) unreachable. */
export class ToggleExecutor implements ChangeSetExecutor {
  refuseStarts = false;
  unavailable = false;
  readonly started: string[] = [];

  constructor(readonly inner: InMemoryExecutor) {}

  async start(req: StartRequest): Promise<StartOutcome> {
    if (this.unavailable) throw new ExecutorUnavailable();
    if (this.refuseStarts) return { ok: false, reason: 'not_executable' };
    this.started.push(req.changesetId);
    return this.inner.start(req);
  }

  cancel(req: Parameters<ChangeSetExecutor['cancel']>[0]): ReturnType<ChangeSetExecutor['cancel']> {
    return this.inner.cancel(req);
  }

  progress(changesetId: string): ReturnType<ChangeSetExecutor['progress']> {
    return this.inner.progress(changesetId);
  }

  // The in-memory run never waits for a signal, so its wake takes no argument.
  wake(): Promise<void> {
    return this.inner.wake();
  }

  requestRollback(req: RollbackRequestInput): Promise<RollbackRequestOutcome> {
    if (this.unavailable) return Promise.reject(new ExecutorUnavailable());
    return this.inner.requestRollback(req);
  }
}
