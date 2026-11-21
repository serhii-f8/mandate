// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { InvocationRequest, InvocationResult, OperationInvoker } from '@aiops/core';

/** Records every invocation and answers `ran <operation id>`; set `failWith` to reject instead. */
export class FakeInvoker implements OperationInvoker {
  readonly calls: InvocationRequest[] = [];
  failWith: Error | undefined;

  invoke(request: InvocationRequest): Promise<InvocationResult> {
    this.calls.push(request);
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve({ text: `ran ${request.operation.id}`, structured: { args: request.args } });
  }
}
