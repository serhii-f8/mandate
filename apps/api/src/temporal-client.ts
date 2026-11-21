// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { Client, Connection } from '@temporalio/client';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry';
import type { ApiEnv } from '@aiops/config';
import type { VersionedKeys } from '@aiops/core';
import { clientDataConverter } from '@aiops/temporal';

/**
 * The api's Temporal client: lazy connection (the api starts while Temporal is down, ADR 0029),
 * encrypting converter (SEC-4), OTel client interceptor (NFR-11). Only the interceptor, not the
 * plugin: the api runs no worker and needs no sink (ruling R3). `ClientInterceptors.workflow` is
 * the non-deprecated form in @temporalio/client 1.25.0 (lib/interceptors.d.ts:322). The interceptor
 * writes the `_tracer-data` header on start, signalWithStart and signal from the active context.
 */
export function createApiTemporalClient(
  env: Pick<ApiEnv, 'temporalAddress' | 'temporalNamespace'>,
  keys: VersionedKeys,
): { connection: Connection; client: Client } {
  const connection = Connection.lazy({ address: env.temporalAddress });
  const client = new Client({
    connection,
    namespace: env.temporalNamespace,
    dataConverter: clientDataConverter(keys),
    interceptors: { workflow: [new OpenTelemetryWorkflowClientInterceptor()] },
  });
  return { connection, client };
}
