/**
 * Change-set attributes on the activity spans of the Temporal plugin (NFR-11): the change-set ID
 * and the correlation ID its audit rows carry for the activity's phase (EXE-4), so a trace is found
 * by the audit's correlation ID. Nothing else is set (SEC-3).
 */
import type { ChangeSetRecord } from '@aiops/core';
import { trace } from '@opentelemetry/api';

export type ActivityPhase = 'prepare' | 'execute' | 'rollback';

/** EXE-4: a rollback's audit rows and transition run under the rollback request's correlation ID. */
export function rollbackCorrelation(cs: ChangeSetRecord): string {
  return cs.rollbackRequest?.correlationId ?? cs.executionRequest?.correlationId ?? cs.correlationId;
}

/** The phase's correlation ID, the one its audit rows carry (ruling F8). */
export function phaseCorrelationId(changeset: ChangeSetRecord, phase: ActivityPhase): string {
  switch (phase) {
    case 'prepare':
      return changeset.correlationId;
    case 'execute':
      return changeset.executionRequest?.correlationId ?? changeset.correlationId;
    case 'rollback':
      return rollbackCorrelation(changeset);
  }
}

/** Sets `aiops.changeset_id` and the phase's correlation ID on the active span (NFR-11); no-op without one. */
export function markActivitySpan(changeset: ChangeSetRecord, phase: ActivityPhase): void {
  trace.getActiveSpan()?.setAttributes({
    'aiops.changeset_id': changeset.id,
    'aiops.correlation_id': phaseCorrelationId(changeset, phase),
  });
}
