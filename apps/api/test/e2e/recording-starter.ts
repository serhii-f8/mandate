// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { WorkflowStarter } from '@mandate/core';

/** Records the IDs it is asked to start (ruling F9): derived change-sets are already prepared. */
export class RecordingStarter implements WorkflowStarter {
  readonly started: string[] = [];

  start(changesetId: string): Promise<void> {
    this.started.push(changesetId);
    return Promise.resolve();
  }
}
