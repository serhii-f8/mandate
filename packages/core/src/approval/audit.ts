// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { AuditEventInput } from '../audit.js';
import type { ChangeSetRecord } from '../changeset/model.js';
import type { ApprovalChannel, DecisionRefusal, DecisionRequest } from './model.js';

type Subject = Pick<ChangeSetRecord, 'id' | 'operation'>;

/** An approval step became current (AUD-1). */
export function approvalRequestedEvent(i: {
  id: string;
  actor: string;
  clientId?: string;
  changeset: Subject;
  round: number;
  step: number;
  role: string;
  correlationId: string;
}): AuditEventInput {
  return {
    id: i.id,
    actor: i.actor,
    ...(i.clientId === undefined ? {} : { clientId: i.clientId }),
    action: 'approval.requested',
    subject: i.changeset.id,
    outcome: 'ok',
    correlationId: i.correlationId,
    changesetId: i.changeset.id,
    details: { round: i.round, step: i.step, role: i.role, operation: i.changeset.operation },
  };
}

/** A decision or its refusal. Never carries the comment text (SEC-3). */
export function approvalDecisionEvent(i: {
  id: string;
  actor: string;
  clientId?: string;
  changeset: Subject;
  round: number;
  step?: number;
  role?: string;
  channel: ApprovalChannel;
  decision: DecisionRequest;
  count: number;
  refusal?: DecisionRefusal;
  correlationId: string;
}): AuditEventInput {
  return {
    id: i.id,
    actor: i.actor,
    ...(i.clientId === undefined ? {} : { clientId: i.clientId }),
    action: 'approval.decision',
    subject: i.changeset.id,
    outcome: i.refusal === undefined ? 'ok' : 'denied',
    correlationId: i.correlationId,
    changesetId: i.changeset.id,
    details: {
      round: i.round,
      ...(i.step === undefined ? {} : { step: i.step }),
      ...(i.role === undefined ? {} : { role: i.role }),
      decision: i.decision,
      channel: i.channel,
      count: i.count,
      operation: i.changeset.operation,
      ...(i.refusal === undefined ? {} : { reason: i.refusal }),
    },
  };
}
