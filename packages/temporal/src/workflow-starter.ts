// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { WorkflowStarter } from '@aiops/core';
import type { Client } from '@temporalio/client';
import { CHANGESET_WORKFLOW, type ChangesetWorkflowInput } from './contract.js';

export interface TemporalWorkflowStarterDeps {
  readonly client: Client;
  readonly taskQueue: string;
}

/**
 * Starts the change-set's workflow, which prepares it and then waits (EXE-1). One workflow per
 * change-set, ever: the workflow ID is the change-set ID, a running one is not reused
 * (conflict policy FAIL) and a closed one cannot run again (REJECT_DUPLICATE, ADR 0027); both
 * reject with `WorkflowExecutionAlreadyStartedError`.
 */
export class TemporalWorkflowStarter implements WorkflowStarter {
  constructor(private readonly deps: TemporalWorkflowStarterDeps) {}

  async start(changesetId: string): Promise<void> {
    const input: ChangesetWorkflowInput = { changesetId };
    await this.deps.client.workflow.start(CHANGESET_WORKFLOW, {
      workflowId: changesetId,
      taskQueue: this.deps.taskQueue,
      args: [input],
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      workflowIdConflictPolicy: 'FAIL',
    });
  }
}
