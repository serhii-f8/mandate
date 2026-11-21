// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { randomUUID } from 'node:crypto';
import {
  approvalRequestedEvent,
  ChangeSetHasher,
  changesetBatchEvent,
  changesetTransitionEvent,
  startEventFactory,
  type ApprovalPlan,
  type ChangeItemRecord,
  type ChangeSetRepository,
  type ChangeSetStatus,
} from '@aiops/core';

/** A change-set seeded straight into `pending_approval`, as the submit path would leave it. */
export interface Seeded {
  id: string;
  hash: string;
  included: number;
}

const OPERATION = 'shop.update_content';
const HOUR = 3_600_000;
const ARGS = { brand: 'acme', changes: { name: 'new' } };

/** The plan each fixture role produces (`approvals-pages-config/roles.yaml`). */
function planOf(role: 'content_manager' | 'catalog_editor', included: number): ApprovalPlan {
  return role === 'content_manager'
    ? { reason: 'above_threshold', steps: ['content_lead', 'brand_owner'], widget: false, threshold: 2, included }
    : { reason: 'role_always', steps: ['content_lead'], stepUp: { maxAgeSeconds: 120 }, widget: false, included };
}

interface PrepareOptions {
  requester: string;
  items: number;
  excluded?: number;
  expiresAt?: Date;
  at?: Date;
  /** Items appended after the generated ones, included in the hash and the stats. */
  extra?: ChangeItemRecord[];
}

/**
 * Seeds a prepared change-set of `shop.update_content` with `items` included items (targets
 * `SKU-0001…`) plus `excluded` excluded ones (the first with reason `not_found`, the rest
 * `no_change`), then the `extra` items as given. The hash is the real one of the stored items.
 */
export function seedPrepared(repo: ChangeSetRepository, o: PrepareOptions): Promise<Seeded> {
  return prepare(repo, o, randomUUID());
}

/** The create → append → complete part, under one correlation ID the caller may reuse. */
async function prepare(repo: ChangeSetRepository, o: PrepareOptions, correlationId: string): Promise<Seeded> {
  const id = randomUUID();
  const at = o.at ?? new Date();
  const changeset = { id, operation: OPERATION };
  await repo.create(
    {
      id,
      operation: OPERATION,
      connection: 'shop',
      requester: o.requester,
      clientId: 'aiops-mcp',
      args: ARGS,
      configHash: 'seeded',
      correlationId,
      createdAt: at,
      expiresAt: o.expiresAt ?? new Date(at.getTime() + 72 * HOUR),
    },
    changesetTransitionEvent({ id: randomUUID(), actor: o.requester, changeset, from: null, to: 'preparing', correlationId }),
  );

  const excluded = o.excluded ?? 0;
  const items: ChangeItemRecord[] = Array.from({ length: o.items + excluded }, (_, i) => {
    const n = i + 1;
    const targetId = `SKU-${String(n).padStart(4, '0')}`;
    const before = { name: `old ${String(n)}` };
    const after = { name: `new ${String(n)}` };
    if (i < o.items) return { targetId, status: 'pending', before, after };
    return { targetId, status: 'excluded', reason: i === o.items ? 'not_found' : 'no_change', before, after };
  });
  items.push(...(o.extra ?? []));
  const included = items.filter((item) => item.status === 'pending').length;
  if (items.length > 0) await repo.appendItems(id, items);

  const hasher = new ChangeSetHasher(OPERATION, ARGS);
  for (const item of items) hasher.add(item);
  const hash = hasher.digest();
  const excludedStats: Record<string, number> = {};
  for (const item of items) if (item.reason !== undefined) excludedStats[item.reason] = (excludedStats[item.reason] ?? 0) + 1;
  await repo.completePreparation(
    id,
    {
      status: 'prepared',
      hash,
      stats: { total: items.length, included, excluded: excludedStats, written: 0, failed: 0, skipped: 0 },
      preparedAt: at,
    },
    changesetTransitionEvent({ id: randomUUID(), actor: 'system', changeset, from: 'preparing', to: 'prepared', correlationId }),
  );
  return { id, hash, included };
}

/**
 * Seeds a prepared change-set as `seedPrepared` does and submits it for approval under the
 * fixture role's plan.
 */
export async function seedPending(
  repo: ChangeSetRepository,
  o: PrepareOptions & {
    groups: string[];
    role: 'content_manager' | 'catalog_editor';
  },
): Promise<Seeded> {
  const at = o.at ?? new Date();
  const correlationId = randomUUID();
  const { id, hash, included } = await prepare(repo, { ...o, at }, correlationId);
  const changeset = { id, operation: OPERATION };

  const plan = planOf(o.role, included);
  const first = plan.steps[0] ?? 'content_lead';
  const result = await repo.submitForApproval({
    changesetId: id,
    expectedHash: hash,
    submission: {
      actor: o.requester,
      groups: o.groups,
      clientId: 'aiops-mcp',
      correlationId,
      at,
      role: o.role,
      rule: `role:${o.role}/grant:${o.role === 'content_manager' ? 'own-brands' : 'editor'}`,
    },
    plan,
    audit: {
      transition: changesetTransitionEvent({ id: randomUUID(), actor: o.requester, changeset, from: 'prepared', to: 'pending_approval', correlationId }),
      requested: approvalRequestedEvent({ id: randomUUID(), actor: o.requester, changeset, round: 1, step: 1, role: first, correlationId }),
    },
    notifications: [],
  });
  if (!result.ok) throw new Error(`seedPending: submitForApproval refused: ${result.reason}`);
  return { id, hash, included };
}

export interface ExecutedOptions {
  requester: string;
  items: number;
  /** Opens the rollback window until then, as the workflow does after the finish. */
  rollbackUntil?: Date;
  status?: Extract<ChangeSetStatus, 'completed' | 'completed_with_errors' | 'cancelled' | 'failed'>;
}

/**
 * Seeds a change-set as `seedPrepared` does, starts it without approval, writes every item in one
 * batch and moves it to `status` (default `completed`); then opens the rollback window when
 * `rollbackUntil` is given (EXE-8).
 */
export async function seedExecuted(repo: ChangeSetRepository, o: ExecutedOptions): Promise<Seeded> {
  const correlationId = randomUUID();
  const seeded = await prepare(repo, { requester: o.requester, items: o.items }, correlationId);
  const { id, hash } = seeded;
  const changeset = { id, operation: OPERATION };
  const request = { actor: o.requester, groups: ['content'], clientId: 'aiops-mcp', correlationId };
  const started = await repo.startExecution({
    changesetId: id,
    expectedHash: hash,
    request,
    now: new Date(),
    event: startEventFactory({ newId: randomUUID, ...request }),
  });
  if (!started.ok) throw new Error(`seedExecuted: startExecution refused: ${started.reason}`);
  const claim = await repo.claimBatch(id, 1, 1, Math.max(o.items, 1));
  if (claim.kind !== 'claimed') throw new Error(`seedExecuted: claimBatch answered ${claim.kind}`);
  const outcomes = claim.items.map((item) => ({ targetId: item.targetId, status: 'written' as const }));
  const audit = changesetBatchEvent({ id: randomUUID(), changeset, batchNo: 1, counts: { written: outcomes.length, failed: 0, skipped: 0 }, correlationId });
  const completed = await repo.completeBatch(id, 1, 1, outcomes, audit);
  if (!completed.ok) throw new Error('seedExecuted: completeBatch fenced');
  const status = o.status ?? 'completed';
  if (status === 'cancelled') {
    const cancel = await repo.requestCancel(id, { actor: o.requester, correlationId, requestedAt: new Date() });
    if (!cancel.ok) throw new Error('seedExecuted: requestCancel refused');
  }
  const moved = await repo.transition(
    id,
    ['executing'],
    status,
    changesetTransitionEvent({ id: randomUUID(), actor: 'system', changeset, from: 'executing', to: status, correlationId }),
  );
  if (moved === undefined) throw new Error(`seedExecuted: could not move to ${status}`);
  if (o.rollbackUntil !== undefined) await repo.openRollbackWindow(id, o.rollbackUntil);
  return seeded;
}
