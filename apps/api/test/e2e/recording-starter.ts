import type { WorkflowStarter } from '@aiops/core';

/** Records the IDs it is asked to start (ruling F9): derived change-sets are already prepared. */
export class RecordingStarter implements WorkflowStarter {
  readonly started: string[] = [];

  start(changesetId: string): Promise<void> {
    this.started.push(changesetId);
    return Promise.resolve();
  }
}
