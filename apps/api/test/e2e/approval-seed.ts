import { randomUUID } from 'node:crypto';
import {
  approvalRequestedEvent,
  ChangeSetHasher,
  changesetTransitionEvent,
  type ApprovalPlan,
  type ChangeItemRecord,
  type ChangeSetRepository,
} from '@aiops/core';

/** A change-set seeded straight into `pending_approval`, as the submit path would leave it. */
export interface Seeded {
  id: string;
  hash: string;
  included: number;
}

const OPERATION = 'shop.update_content';
const HOUR = 3_600_000;

/** The plan each fixture role produces (`approvals-pages-config/roles.yaml`). */
function planOf(role: 'content_manager' | 'catalog_editor', included: number): ApprovalPlan {
  return role === 'content_manager'
    ? { reason: 'above_threshold', steps: ['content_lead', 'brand_owner'], widget: false, threshold: 2, included }
    : { reason: 'role_always', steps: ['content_lead'], stepUp: { maxAgeSeconds: 120 }, widget: false, included };
}

/**
 * Seeds a prepared change-set of `shop.update_content` with `items` included items (targets
 * `SKU-0001…`) plus `excluded` excluded ones (the first with reason `not_found`), and submits it
 * for approval under the fixture role's plan. The hash is the real one of the stored items.
 */
export async function seedPending(
  repo: ChangeSetRepository,
  o: {
    requester: string;
    groups: string[];
    role: 'content_manager' | 'catalog_editor';
    items: number;
    excluded?: number;
    expiresAt?: Date;
    at?: Date;
  },
): Promise<Seeded> {
  const id = randomUUID();
  const at = o.at ?? new Date();
  const correlationId = randomUUID();
  const args = { brand: 'acme', changes: { name: 'new' } };
  const changeset = { id, operation: OPERATION };
  await repo.create(
    {
      id,
      operation: OPERATION,
      connection: 'shop',
      requester: o.requester,
      clientId: 'aiops-mcp',
      args,
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
  if (items.length > 0) await repo.appendItems(id, items);

  const hasher = new ChangeSetHasher(OPERATION, args);
  for (const item of items) hasher.add(item);
  const hash = hasher.digest();
  const excludedStats: Record<string, number> = {};
  for (const item of items) if (item.reason !== undefined) excludedStats[item.reason] = (excludedStats[item.reason] ?? 0) + 1;
  await repo.completePreparation(
    id,
    {
      status: 'prepared',
      hash,
      stats: { total: items.length, included: o.items, excluded: excludedStats, written: 0, failed: 0, skipped: 0 },
      preparedAt: at,
    },
    changesetTransitionEvent({ id: randomUUID(), actor: 'system', changeset, from: 'preparing', to: 'prepared', correlationId }),
  );

  const plan = planOf(o.role, o.items);
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
  return { id, hash, included: o.items };
}
