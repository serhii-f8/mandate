/**
 * Which path an allowed call takes, by risk class (SPEC section 2, design §4.1): reads run
 * directly, writes with a manifest prepare a change-set, everything else is refused until
 * a later phase supports it. Nothing writes upstream from here (CS-1).
 */
import type { LoadedConfiguration } from '@aiops/config';
import type { ChangeSetRepository, InvocationRequest, InvocationResult, OperationInvoker } from '@aiops/core';
import { ChangeSetInvoker } from '../changesets/changeset-invoker.js';
import type { PipelineDeps } from '../mcp/tool-pipeline.js';
import { DirectReadInvoker, type DirectReadInvokerDeps } from './read-invoker.js';
import { riskNotSupportedResult } from './risk-not-supported.js';
import { createUpstreamReader } from './upstream-reader.js';

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
}

/** The per-call invoker the pipeline asks for, every path bound to the request's snapshot (SEC-1). */
export function operationInvokers(base: OperationInvokersBase): PipelineDeps['invokerFor'] {
  return (configuration: LoadedConfiguration, correlationId: string) => {
    const io = { configuration, vault: base.vault, adapter: base.adapter, correlationId, ...(base.log === undefined ? {} : { log: base.log }) };
    return new OperationRouter({
      read: new DirectReadInvoker(io),
      changeset: new ChangeSetInvoker({
        configuration,
        repository: base.repository,
        reader: createUpstreamReader(io),
        newId: base.newId,
        now: base.now,
        correlationId,
      }),
    });
  };
}
