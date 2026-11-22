// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ChangeSetRecord, ExecutionRequest, RollbackRequest } from '@mandate/core';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markActivitySpan, phaseCorrelationId } from './span-attributes.js';

/** Only the fields the functions read; the rest of the record does not matter here. */
function record(fields: Partial<ChangeSetRecord>): ChangeSetRecord {
  return { id: 'cs-1', correlationId: 'corr-prepare', ...fields } as ChangeSetRecord; // a partial record, enough for the fields read
}

const execution: ExecutionRequest = { actor: 'alice', groups: ['editors'], correlationId: 'corr-execute', startedAt: new Date(0) };
const rollback: RollbackRequest = { actor: 'bob', correlationId: 'corr-rollback', requestedAt: new Date(0) };

describe('NFR-11 activity span attributes', () => {
  it('NFR-11 phaseCorrelationId picks the preparation, execution or rollback correlation ID', () => {
    const bare = record({});
    expect(phaseCorrelationId(bare, 'prepare')).toBe('corr-prepare');
    expect(phaseCorrelationId(bare, 'execute')).toBe('corr-prepare');
    expect(phaseCorrelationId(bare, 'rollback')).toBe('corr-prepare');

    const executed = record({ executionRequest: execution });
    expect(phaseCorrelationId(executed, 'prepare')).toBe('corr-prepare');
    expect(phaseCorrelationId(executed, 'execute')).toBe('corr-execute');
    // Ruling F8: a rollback without its own request runs under the execution's ID, as its audit rows do.
    expect(phaseCorrelationId(executed, 'rollback')).toBe('corr-execute');

    const rolledBack = record({ executionRequest: execution, rollbackRequest: rollback });
    expect(phaseCorrelationId(rolledBack, 'prepare')).toBe('corr-prepare');
    expect(phaseCorrelationId(rolledBack, 'execute')).toBe('corr-execute');
    expect(phaseCorrelationId(rolledBack, 'rollback')).toBe('corr-rollback');
  });

  describe('with a tracer', () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

    beforeAll(() => {
      // Registers the context manager, so `startActiveSpan` makes the span active.
      provider.register();
    });
    afterAll(async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    });

    it('NFR-11 markActivitySpan sets exactly mandate.changeset_id and mandate.correlation_id on the active span', () => {
      const cs = record({ executionRequest: execution });
      provider.getTracer('test').startActiveSpan('activity', (span) => {
        markActivitySpan(cs, 'execute');
        span.end();
      });
      expect(exporter.getFinishedSpans().map((s) => s.attributes)).toEqual([{ 'mandate.changeset_id': 'cs-1', 'mandate.correlation_id': 'corr-execute' }]);
    });

    it('NFR-11 markActivitySpan is a no-op without an active span', () => {
      expect(trace.getActiveSpan()).toBeUndefined();
      expect(() => {
        markActivitySpan(record({}), 'prepare');
      }).not.toThrow();
    });
  });
});
