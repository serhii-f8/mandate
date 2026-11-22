// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Which path an allowed call takes, by risk class (SPEC section 2, design §4.1): reads run
 * directly; opaque operations and writes or destructive operations with a manifest create a
 * change-set and start its workflow; anything else is refused (fail closed). Nothing writes
 * upstream from here (CS-1).
 */
import type { LoadedConfiguration } from '@mandate/config';
import { setTimeout as delay } from 'node:timers/promises';
import type { UpstreamToolView } from '@mandate/upstream';
import type { ChangeSetRepository, InvocationRequest, InvocationResult, OperationInvoker, TaskRepository, WorkflowStarter } from '@mandate/core';
import { ChangeSetInvoker, checkPrepareWait, preparesChangeSet } from '../changesets/changeset-invoker.js';
import type { PipelineDeps } from '../mcp/tool-pipeline.js';
import { pinRefusal, usablePin } from './pin-refusal.js';
import { DirectReadInvoker, type DirectReadInvokerDeps } from './read-invoker.js';
import { riskNotSupportedResult } from './risk-not-supported.js';

export { riskNotSupportedResult };

/** What the router needs to refuse MCP-backed operations by pin state (CONN-4). */
export interface RouterUpstream {
  /** The request's configuration snapshot, the one its policy decision used (SEC-1). */
  readonly configuration: LoadedConfiguration;
  /** Pin states; without it every MCP-backed operation is refused (fail closed). */
  readonly upstreamTools?: UpstreamToolView;
}

export class OperationRouter implements OperationInvoker {
  /** `upstream` is required: without the configuration the router could not tell an MCP-backed operation apart (fail closed). */
  constructor(
    private readonly paths: { readonly read: OperationInvoker; readonly changeset: OperationInvoker },
    private readonly upstream: RouterUpstream,
  ) {}

  invoke(request: InvocationRequest): Promise<InvocationResult> {
    const { operation } = request;
    // R8: an MCP-backed operation runs only while its pinned tool is `ok`, whatever its risk
    // class; the read path itself does not check the pin (performRead assumes the caller did).
    const { configuration, upstreamTools } = this.upstream;
    const binding = configuration.bindings.get(operation.id);
    if (binding?.kind === 'mcp') {
      const refusal = pinRefusal(operation, usablePin(binding, upstreamTools?.view(configuration, operation.id)));
      if (refusal !== undefined) return Promise.resolve(refusal);
    }
    if (operation.risk === 'read') return this.paths.read.invoke(request);
    if (preparesChangeSet(operation)) return this.paths.changeset.invoke(request);
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
  /** How long a call without Tasks waits for preparation (`MANDATE_PREPARE_WAIT_MS`). */
  readonly prepareWaitMs: number;
  /** Poll interval of that wait; 250 ms. */
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Pin states of MCP-backed operations (CONN-4); without it they are refused. */
  readonly upstreamTools?: UpstreamToolView;
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
    }, { configuration, ...(base.upstreamTools === undefined ? {} : { upstreamTools: base.upstreamTools }) });
  };
}
