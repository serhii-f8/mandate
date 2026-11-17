/**
 * Which path an allowed call takes, by risk class (SPEC section 2, design §4.1): reads run
 * directly, writes with a manifest create a change-set and start its workflow, everything else
 * is refused until a later phase supports it. Nothing writes upstream from here (CS-1).
 */
import type { LoadedConfiguration } from '@aiops/config';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChangeSetRepository, InvocationRequest, InvocationResult, OperationInvoker, TaskRepository, WorkflowStarter } from '@aiops/core';
import { ChangeSetInvoker, checkPrepareWait } from '../changesets/changeset-invoker.js';
import type { PipelineDeps } from '../mcp/tool-pipeline.js';
import { DirectReadInvoker, type DirectReadInvokerDeps } from './read-invoker.js';
import { riskNotSupportedResult } from './risk-not-supported.js';

export { riskNotSupportedResult };

export class OperationRouter implements OperationInvoker {
  constructor(private readonly paths: { readonly read: OperationInvoker; readonly changeset: OperationInvoker }) {}

  invoke(request: InvocationRequest): Promise<InvocationResult> {
    const { operation } = request;
    if (operation.risk === 'read') return this.paths.read.invoke(request);
    if (operation.risk === 'write' && operation.manifest !== undefined) return this.paths.changeset.invoke(request);
    return Promise.resolve(riskNotSupportedResult(operation));
  }
}

export interface OperationInvokersBase extends Omit<DirectReadInvokerDeps, 'configuration' | 'correlationId'> {
  readonly repository: ChangeSetRepository;
  readonly newId: () => string;
  /** Wall clock, for change-set timestamps and expiry. */
  readonly now: () => Date;
  readonly tasks: TaskRepository;
  /** Starts the change-set workflow, which prepares it (EXE-1). */
  readonly starter: WorkflowStarter;
  /** How long a call without Tasks waits for preparation (`AIOPS_PREPARE_WAIT_MS`). */
  readonly prepareWaitMs: number;
  /** Poll interval of that wait; 250 ms. */
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const POLL_MS = 250;

/** The per-call invoker the pipeline asks for, every path bound to the request's snapshot (SEC-1). */
export function operationInvokers(base: OperationInvokersBase): PipelineDeps['invokerFor'] {
  const wait = { timeoutMs: base.prepareWaitMs, pollMs: base.pollMs ?? POLL_MS, sleep: base.sleep ?? ((ms: number) => delay(ms)) };
  // Checked once here too, so a bad setting stops the start instead of failing every write call.
  checkPrepareWait(wait);
  return (configuration: LoadedConfiguration, correlationId: string) => {
    const io = { configuration, vault: base.vault, adapter: base.adapter, correlationId, ...(base.log === undefined ? {} : { log: base.log }) };
    return new OperationRouter({
      read: new DirectReadInvoker(io),
      changeset: new ChangeSetInvoker({
        configuration,
        repository: base.repository,
        tasks: base.tasks,
        starter: base.starter,
        newId: base.newId,
        now: base.now,
        correlationId,
        wait,
      }),
    });
  };
}
