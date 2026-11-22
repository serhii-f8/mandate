// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { AuditEventInput } from '../audit.js';
import type { ChangeSetRecord, ChangeSetStatus } from './model.js';

export interface ChangesetTransitionInput {
  readonly id: string;
  readonly actor: string;
  readonly clientId?: string;
  readonly changeset: Pick<ChangeSetRecord, 'id' | 'operation'>;
  readonly from: ChangeSetStatus | null;
  readonly to: ChangeSetStatus;
  readonly correlationId: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

/** Audit event for a change-set status change (AUD-1, AUD-2). Details carry no argument values (SEC-3). */
export function changesetTransitionEvent(input: ChangesetTransitionInput): AuditEventInput {
  return {
    id: input.id,
    actor: input.actor,
    ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
    action: 'changeset.transition',
    subject: input.changeset.operation,
    outcome: input.to === 'failed' ? 'error' : 'ok',
    correlationId: input.correlationId,
    changesetId: input.changeset.id,
    details: { from: input.from, to: input.to, operation: input.changeset.operation, ...input.details },
  };
}
