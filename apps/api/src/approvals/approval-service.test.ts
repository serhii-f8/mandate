import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import {
  ExecutorUnavailable,
  type ApprovalChannel,
  type Approver,
  type ChangeSetExecutor,
  type ChangeSetRecord,
  type DecisionRefusal,
  type DecisionRequest,
  type ExecutionProgress,
  type StartOutcome,
  type StartRequest,
} from '@aiops/core';
import {
  InMemoryAuditLog,
  InMemoryChangeSetRepository,
  InMemoryExecutor,
  recordApproval,
  ScriptedWriter,
  submitChangeSet,
} from '@aiops/testing';
import { ApprovalService } from './approval-service.js';
import { DECISION_REFUSAL_TEXT } from './texts.js';

const ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const HASH = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-11-17T10:00:00.000Z');
const SUBMITTED = new Date('2026-11-17T09:59:00.000Z');
const FAR =new Date('2099-01-01T00:00:00.000Z');

/** Role `writer` is the submission role of `submitChangeSet`; `lead` and `brand` are approval step roles. */
async function configuration(recordsPerOperation: number): Promise<LoadedConfiguration> {
  const loaded = await loadConfigurationSources([
    {
      file: 'connections.yaml',
      text: `version: 1
connections:
  - { id: magento, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: magento-integration, auth: { scheme: bearer } }
`,
    },
    {
      file: 'operations.yaml',
      text: `version: 1
operations:
  - id: catalog.get_products
    connection: magento
    risk: read
    description: Products by SKU.
    upstream: { method: GET, path: /V1/products, query: { skus: { arg: skus, join: ',' } }, response: { items: items, fields_from_arg: fields } }
    input_schema:
      type: object
      properties: { skus: { type: array, items: { type: string } }, fields: { type: array, items: { type: string } } }
      required: [skus, fields]
    fields_arg: fields
  - id: catalog.update_content
    connection: magento
    risk: write
    description: Update content.
    upstream: { method: POST, path: /async/bulk/V1/products }
    input_schema:
      type: object
      properties:
        skus: { type: array, items: { type: string } }
        changes: { type: object, properties: { name: { type: string } }, additionalProperties: false }
      required: [skus, changes]
    manifest:
      id_field: sku
      ids_arg: skus
      values_arg: changes
      fields: [name]
      read_before: { operation: catalog.get_products, ids_arg: skus }
      rollback: { strategy: replay_previous_state }
`,
    },
    {
      file: 'roles.yaml',
      text: `version: 1
roles:
  - id: writer
    grants:
      - { operation: catalog.update_content, id: all }
    limits: { records_per_operation: ${String(recordsPerOperation)} }
    approval: { required: always, steps: [{ role: lead }, { role: brand }] }
  - id: lead
    grants: []
  - id: brand
    grants: []
role_mapping:
  - { group: content, roles: [writer] }
  - { group: leads, roles: [lead] }
  - { group: brands, roles: [brand] }
`,
    },
  ]);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  return loaded.configuration;
}

const CONFIG = await configuration(50);
const ONE_RECORD = await configuration(1);

const bob: Approver = { subject: 'bob', name: 'Bob', roles: ['lead'], clientId: 'aiops-web' };
const carol: Approver = { subject: 'carol', roles: ['brand'] };

/** Records starts and wakes; delegates to the in-memory executor unless made unavailable. */
class SpyExecutor implements ChangeSetExecutor {
  readonly starts: StartRequest[] = [];
  readonly wakes: string[] = [];
  unavailable = false;
  constructor(readonly inner: InMemoryExecutor) {}
  start(req: StartRequest): Promise<StartOutcome> {
    this.starts.push(req);
    return this.unavailable ? Promise.reject(new ExecutorUnavailable()) : this.inner.start(req);
  }
  cancel(req: Parameters<ChangeSetExecutor['cancel']>[0]): ReturnType<ChangeSetExecutor['cancel']> {
    return this.inner.cancel(req);
  }
  progress(id: string): Promise<ExecutionProgress | undefined> {
    return this.inner.progress(id);
  }
  wake(id: string): Promise<void> {
    this.wakes.push(id);
    return this.inner.wake();
  }
}

async function setup(
  options: { steps?: readonly string[]; stepUp?: number; submit?: boolean; expiresAt?: Date; items?: number } = {},
) {
  const audit = new InMemoryAuditLog();
  const repository = new InMemoryChangeSetRepository(audit);
  const event = { id: 'e0', actor: 'alice', action: 'changeset.transition' as const, outcome: 'ok' as const, correlationId: 'c0', details: {} };
  await repository.create(
    {
      id: ID,
      operation: 'catalog.update_content',
      connection: 'magento',
      requester: 'alice',
      args: { skus: ['a', 'b'] },
      configHash: 'h',
      correlationId: 'c0',
      createdAt: NOW,
      expiresAt: options.expiresAt ?? FAR,
    },
    event,
  );
  const targets = ['a', 'b', 'c'].slice(0, options.items ?? 2);
  await repository.appendItems(ID, targets.map((targetId) => ({ targetId, status: 'pending' as const, before: null, after: null })));
  const n = targets.length;
  const prepared = await repository.completePreparation(
    ID,
    { status: 'prepared', hash: HASH, stats: { total: n, included: n, excluded: {}, written: 0, failed: 0, skipped: 0 }, preparedAt: NOW },
    { ...event, id: 'e1' },
  );
  if (prepared === undefined) throw new Error('preparation failed');
  let changeset: ChangeSetRecord = prepared;
  if (options.submit ?? true) {
    changeset = await submitChangeSet(repository, prepared, {
      steps: options.steps ?? ['lead'],
      groups: ['content'],
      at: SUBMITTED,
      ...(options.stepUp === undefined ? {} : { stepUp: options.stepUp }),
    });
  }
  const inner = new InMemoryExecutor({ repository, writer: new ScriptedWriter(), batchSizeOf: () => 100 });
  const executor = new SpyExecutor(inner);
  let id = 0;
  const service = new ApprovalService({
    repository,
    executor,
    audit,
    newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    now: () => NOW,
  });
  const before = audit.events.length;
  const added = () => audit.events.slice(before);
  return { audit, repository, executor, inner, service, changeset, added };
}

function input(over: {
  changesetId?: string;
  decision?: DecisionRequest;
  hash?: string;
  count?: number;
  comment?: string;
  approver?: Approver;
  channel?: ApprovalChannel;
  snapshot?: LoadedConfiguration;
} = {}) {
  return {
    changesetId: over.changesetId ?? ID,
    decision: over.decision ?? ('approve' as const),
    hash: over.hash ?? HASH,
    count: over.count ?? 2,
    ...(over.comment === undefined ? {} : { comment: over.comment }),
    approver: over.approver ?? bob,
    channel: over.channel ?? ('page' as const),
    correlationId: 'corr-d',
    snapshot: over.snapshot ?? CONFIG,
  };
}

type Arrange = Awaited<ReturnType<typeof setup>>;

const REFUSALS: {
  reason: DecisionRefusal;
  setup?: Parameters<typeof setup>[0];
  arrange?: (s: Arrange) => Promise<void>;
  input: NonNullable<Parameters<typeof input>[0]>;
}[] = [
  { reason: 'not_found', input: { changesetId: UNKNOWN } },
  { reason: 'not_found', input: { approver: { subject: 'eve', roles: ['other'] } } },
  {
    reason: 'not_pending',
    arrange: async (s) => {
      await recordApproval(s.repository, s.changeset, { approver: 'dave', decision: 'rejected' });
    },
    input: {},
  },
  { reason: 'not_approver', setup: { steps: ['lead', 'brand'] }, input: { approver: carol } },
  { reason: 'separation_of_duties', input: { approver: { subject: 'alice', roles: ['lead'] } } },
  { reason: 'widget_not_allowed', input: { channel: 'widget' } },
  { reason: 'step_up_required', setup: { stepUp: 120 }, input: {} },
  { reason: 'hash_mismatch', input: { hash: `sha256:${'b'.repeat(64)}` } },
  { reason: 'count_mismatch', input: { count: 3 } },
  { reason: 'comment_required', input: { decision: 'return' } },
  { reason: 'comment_invalid', input: { decision: 'reject', comment: 'x'.repeat(2001) } },
  { reason: 'comment_invalid', input: { decision: 'reject', comment: 'a\u0007b' } },
];

describe('APR-1 APR-2 SEC-1 approval service', () => {
  it.each(REFUSALS)(
    'SEC-1 SEC-11 every refusal is audited approval.decision denied with the reason, and nothing is stored ($reason)',
    async (c) => {
      const s = await setup(c.setup);
      await c.arrange?.(s);
      const statusBefore = (await s.repository.get(ID))?.status;
      const approvalsBefore = (await s.repository.approvals(ID)).length;
      const before = s.audit.events.length;

      const answer = await s.service.decide(input(c.input));

      expect(answer).toEqual({ ok: false, reason: c.reason });
      const added = s.audit.events.slice(before);
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({
        action: 'approval.decision',
        outcome: 'denied',
        actor: c.input.approver?.subject ?? 'bob',
        correlationId: 'corr-d',
        details: { reason: c.reason },
      });
      expect(await s.repository.approvals(ID)).toHaveLength(approvalsBefore);
      expect((await s.repository.get(ID))?.status).toBe(statusBefore);
      expect(s.executor.starts).toEqual([]);
      expect(s.executor.wakes).toEqual([]);
    },
  );

  it('CS-6 an expired change-set is moved to expired by system and refused expired', async () => {
    const s = await setup({ expiresAt: NOW });
    const answer = await s.service.decide(input());
    expect(answer).toEqual({ ok: false, reason: 'expired' });
    expect((await s.repository.get(ID))?.status).toBe('expired');
    expect(s.added()).toMatchObject([
      { action: 'changeset.transition', actor: 'system', details: { from: 'pending_approval', to: 'expired' } },
      { action: 'approval.decision', outcome: 'denied', details: { reason: 'expired' } },
    ]);
    expect(await s.repository.approvals(ID)).toEqual([]);
  });

  it('CS-6 a change-set already expired, or a lost expiry CAS, still answers expired with no second transition', async () => {
    const s = await setup({ expiresAt: NOW });
    await s.service.decide(input());
    const again = await s.service.decide(input());
    expect(again).toEqual({ ok: false, reason: 'expired' });
    const transitions = s.added().filter((e) => e.action === 'changeset.transition');
    expect(transitions).toHaveLength(1);

    // Lost CAS: someone else moves it between the read and the write.
    const t = await setup({ expiresAt: NOW });
    t.repository.transition = () => Promise.resolve(undefined);
    expect(await t.service.decide(input())).toEqual({ ok: false, reason: 'expired' });
  });

  it('APR-3 approving step 1 of two leaves pending_approval and audits approval.requested for step 2', async () => {
    const s = await setup({ steps: ['lead', 'brand'] });
    const answer = await s.service.decide(input());
    expect(answer).toEqual({ ok: true, status: 'pending_approval' });
    const cs = await s.repository.get(ID);
    expect(cs?.status).toBe('pending_approval');
    expect(cs?.awaitingRole).toBe('brand');
    expect(s.added()).toMatchObject([
      {
        action: 'approval.decision',
        outcome: 'ok',
        actor: 'bob',
        clientId: 'aiops-web',
        details: { round: 1, step: 1, role: 'lead', decision: 'approve', channel: 'page', count: 2 },
      },
      { action: 'approval.requested', details: { round: 1, step: 2, role: 'brand' } },
    ]);
    const [row] = await s.repository.approvals(ID);
    expect(row).toMatchObject({
      changesetId: ID,
      round: 1,
      step: 1,
      role: 'lead',
      approver: 'bob',
      approverName: 'Bob',
      decision: 'approved',
      hash: HASH,
      itemCount: 2,
      channel: 'page',
      clientId: 'aiops-web',
      correlationId: 'corr-d',
      ts: NOW,
    });
    expect(row).not.toHaveProperty('comment');
    expect(s.executor.starts).toEqual([]);
    expect(s.executor.wakes).toEqual([]);
  });

  it('APR-4 return moves to prepared and wakes the workflow', async () => {
    const s = await setup();
    const answer = await s.service.decide(input({ decision: 'return', comment: 'fix the titles' }));
    expect(answer).toEqual({ ok: true, status: 'prepared' });
    expect((await s.repository.get(ID))?.status).toBe('prepared');
    expect(s.executor.wakes).toEqual([ID]);
    expect(s.added().map((e) => e.action)).toEqual(['approval.decision', 'changeset.transition']);
    expect(s.added()[1]?.details).toMatchObject({ from: 'pending_approval', to: 'prepared' });
    expect((await s.repository.approvals(ID))[0]).toMatchObject({ decision: 'returned', comment: 'fix the titles' });
  });

  it('APR-1 reject moves to rejected and wakes', async () => {
    const s = await setup();
    const answer = await s.service.decide(input({ decision: 'reject', hash: 'sha256:stale', count: 0 }));
    expect(answer).toEqual({ ok: true, status: 'rejected' });
    expect((await s.repository.get(ID))?.status).toBe('rejected');
    expect(s.executor.wakes).toEqual([ID]);
    expect(s.added()[1]?.details).toMatchObject({ from: 'pending_approval', to: 'rejected' });
    expect(s.executor.starts).toEqual([]);
  });

  it('APR-3 a decision that loses the race is refused not_pending and audited', async () => {
    const s = await setup();
    s.repository.recordDecision = () => Promise.resolve({ ok: false, reason: 'not_pending' });
    expect(await s.service.decide(input())).toEqual({ ok: false, reason: 'not_pending' });
    expect(s.added()).toMatchObject([
      { action: 'approval.decision', outcome: 'denied', details: { reason: 'not_pending' } },
    ]);
    expect(s.executor.starts).toEqual([]);
  });

  it('POL-6 the last approval starts execution with the requester identity of the submission and the role limits', async () => {
    const s = await setup();
    const answer = await s.service.decide(input());
    expect(answer).toEqual({ ok: true, status: 'approved', start: { ok: true } });
    expect(s.executor.starts).toEqual([
      {
        changesetId: ID,
        expectedHash: HASH,
        actor: 'bob',
        clientId: 'aiops-web',
        correlationId: 'corr-d',
        requester: { subject: 'alice', groups: ['content'] },
        limits: { role: 'writer', recordsPerOperation: 50 },
      },
    ]);
    await s.inner.settled(ID);
    const cs = await s.repository.get(ID);
    expect(cs?.status).toBe('completed');
    expect(cs?.executionRequest).toMatchObject({ actor: 'alice', groups: ['content'] });
    const executing = s.added().find((e) => e.action === 'changeset.transition' && e.details.to === 'executing');
    expect(executing?.actor).toBe('bob');
  });

  it('a start refusal after approval leaves approved and reports it separately', async () => {
    const s = await setup();
    const answer = await s.service.decide(input({ snapshot: ONE_RECORD }));
    expect(answer).toEqual({ ok: true, status: 'approved', start: { ok: false, reason: 'limit_exceeded', limit: 'records_per_operation' } });
    expect((await s.repository.get(ID))?.status).toBe('approved');
    expect(s.added().at(-1)).toMatchObject({
      action: 'changeset.start',
      outcome: 'denied',
      actor: 'bob',
      changesetId: ID,
      details: { reason: 'limit_exceeded', limit: 'records_per_operation' },
    });
  });

  it('an unavailable executor reports executor_unavailable and the approval stands', async () => {
    const s = await setup();
    s.executor.unavailable = true;
    const answer = await s.service.decide(input());
    expect(answer).toEqual({ ok: true, status: 'approved', start: 'executor_unavailable' });
    if (answer.ok) expect(answer.start).toBe('executor_unavailable');
    expect((await s.repository.get(ID))?.status).toBe('approved');
    expect(await s.repository.approvals(ID)).toHaveLength(1);
    expect(s.added().at(-1)).toMatchObject({ action: 'changeset.start', outcome: 'denied', details: { reason: 'executor_unavailable' } });
  });

  it('startApproved refuses a change-set that is not approved and audits changeset.start denied not_executable', async () => {
    const s = await setup();
    const outcome = await s.service.startApproved({ changesetId: ID, actor: 'bob', correlationId: 'corr-s', snapshot: CONFIG });
    expect(outcome).toEqual({ ok: false, reason: 'not_executable' });
    expect(s.added()).toMatchObject([
      { action: 'changeset.start', outcome: 'denied', actor: 'bob', correlationId: 'corr-s', changesetId: ID, details: { reason: 'not_executable' } },
    ]);
    expect(s.executor.starts).toEqual([]);

    const unknown = await s.service.startApproved({ changesetId: UNKNOWN, actor: 'bob', correlationId: 'corr-s', snapshot: CONFIG });
    expect(unknown).toEqual({ ok: false, reason: 'not_found' });
    expect(s.added().at(-1)).toMatchObject({ action: 'changeset.start', outcome: 'denied', details: { reason: 'not_found' } });
  });

  it('SEC-3 an accepted comment never reaches the audit log', async () => {
    const s = await setup();
    const comment = 'secret-ish remark: call 555-0100';
    expect(await s.service.decide(input({ decision: 'reject', comment }))).toEqual({ ok: true, status: 'rejected' });
    expect((await s.repository.approvals(ID))[0]?.comment).toBe(comment);
    expect(JSON.stringify(s.audit.events)).not.toContain('555-0100');
  });

  it('SEC-5 every decision refusal has its fixed text', () => {
    expect(DECISION_REFUSAL_TEXT.not_found(ID)).toBe(`Change-set ${ID} was not found.`);
    expect(DECISION_REFUSAL_TEXT.expired(ID)).toBe(`Change-set ${ID} has expired.`);
    expect(DECISION_REFUSAL_TEXT.not_pending(ID)).toBe(`Change-set ${ID} is not awaiting approval.`);
    expect(DECISION_REFUSAL_TEXT.not_approver(ID)).toBe('You do not hold the role this approval step needs.');
    expect(DECISION_REFUSAL_TEXT.separation_of_duties(ID)).toBe(
      'You cannot decide this step: you requested the change-set or decided an earlier step.',
    );
    expect(DECISION_REFUSAL_TEXT.widget_not_allowed(ID)).toBe('This change-set must be decided on the approval page.');
    expect(DECISION_REFUSAL_TEXT.step_up_required(ID)).toBe('Log in again to decide this change-set.');
    expect(DECISION_REFUSAL_TEXT.hash_mismatch(ID)).toBe('The change-set changed; review it again.');
    expect(DECISION_REFUSAL_TEXT.count_mismatch(ID)).toBe('The number of changes does not match; review the change-set again.');
    expect(DECISION_REFUSAL_TEXT.comment_required(ID)).toBe('A comment is required to return a change-set.');
    expect(DECISION_REFUSAL_TEXT.comment_invalid(ID)).toBe(
      'The comment is longer than 2000 characters or contains control characters.',
    );
  });
});
