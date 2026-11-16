import type { ConnectionConfig } from '@aiops/config';
import type { InvocationRequest, InvocationResult, OperationInvoker } from '@aiops/core';

/**
 * The invoker until adapters exist (Phase 3): an allowed call ends in an
 * explicit error naming the missing adapter (ADR 0016).
 */
export class NoAdapterInvoker implements OperationInvoker {
  constructor(private readonly connections: () => readonly ConnectionConfig[]) {}

  invoke({ operation }: InvocationRequest): Promise<InvocationResult> {
    const connection = this.connections().find((c) => c.id === operation.connection);
    const adapter = connection?.adapter ?? 'unknown';
    return Promise.resolve({
      isError: true,
      text: `Operation ${operation.id} cannot run: no adapter is available for connection ${operation.connection} (adapter ${adapter}).`,
    });
  }
}
