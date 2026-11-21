// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry';
import { parseTemporalKeys } from '@aiops/temporal';
import { createApiTemporalClient } from './temporal-client.js';

/** An obviously fake key (32 bytes, base64) — never used outside tests. */
const KEYS = parseTemporalKeys('1:ZGV2LW9ubHktdGVtcG9yYWwta2V5LTAxMjM0NTY3ODk=');

describe('NFR-11 SEC-4 api Temporal client', () => {
  it('NFR-11 SEC-4 the api client has the OTel workflow interceptor and the encrypting codec', async () => {
    // Nothing listens on port 1: a connect attempt would fail, so the lazy client must not try.
    const { connection, client } = createApiTemporalClient({ temporalAddress: '127.0.0.1:1', temporalNamespace: 'default' }, KEYS);
    try {
      const workflowInterceptors = client.options.interceptors.workflow;
      expect(Array.isArray(workflowInterceptors)).toBe(true);
      expect((workflowInterceptors as unknown[]).some((i) => i instanceof OpenTelemetryWorkflowClientInterceptor)).toBe(true);
      expect(client.options.loadedDataConverter.payloadCodecs).toHaveLength(1);
      expect(client.options.namespace).toBe('default');
    } finally {
      await connection.close();
    }
  });
});
