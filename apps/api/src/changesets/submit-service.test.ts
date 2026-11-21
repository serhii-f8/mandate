// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { loadConfigurationSources, type LoadedConfiguration } from '@aiops/config';
import { ExecutorUnavailable, type Caller, type ChangeSetExecutor, type ExecutionProgress, type StartOutcome, type StartRequest } from '@aiops/core';
import { InMemoryAuditLog, InMemoryChangeSetRepository } from '@aiops/testing';
import { ApprovalService } from '../approvals/approval-service.js';
import { snapshotOf, type Snapshot } from '../mcp/tool-pipeline.js';
import { SubmitService } from './submit-service.js';

function sources(scope: string) {
  return {
    'connections.yaml': `version: 1
connections:
  - { id: magento, adapter: openapi, base_url: https://shop.example.test/rest, credential_ref: magento-integration, auth: { scheme: bearer } }
`,
    'operations.yaml': `version: 1
operations:
  - id: catalog.get_products
    connection: magento
    risk: read
    description: Products by SKU.
    upstream: { method: GET, path: /V1/products, query: { skus: { arg: skus, join: ',' }, brand: { arg: brand } }, response: { items: items, fields_from_arg: fields } }
    input_schema:
      type: object
      properties: { skus: { type: array, items: { type: string } }, brand: { type: string }, fields: { type: array, items: { type: string } } }
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
        brand: { type: string }
        skus: { type: array, items: { type: string } }
        changes: { type: object, properties: { name: { type: string } }, additionalProperties: false }
      required: [brand, changes]
    manifest:
      id_field: sku
      ids_arg: skus
      values_arg: changes
      fields: [name]
      scope_args: { brand: brand }
      read_before:
        operation: catalog.get_products
        ids_arg: skus
        args: { brand: { arg: brand } }
      rollback: { strategy: replay_previous_state }
  - id: notes.create
    connection: magento
    risk: write_opaque
    description: Create a note.
    upstream: { method: POST, path: /V1/notes }
    input_schema:
      type: object
      properties: { text: { type: string } }
      required: [text]
`,
    'roles.yaml': `version: 1
roles:
  - id: content_manager
    grants:
      - { operation: catalog.update_content, id: own-brands, scope: { brand: [${scope}] } }
    limits: { records_per_operation: 50, records_per_day: 500, concurrent_executions: 2 }
    approval: { required: never, steps: [{ role: other_role }] }
  - id: other_role
    grants:
      - { operation: catalog.update_content, id: all }
    approval: { steps: [{ role: content_manager }] }
  - id: always_role
    grants:
      - { operation: catalog.update_content, id: all }
    approval: { required: always, steps: [{ role: content_manager }] }
  - id: opaque_role
    grants:
      - { operation: notes.create, id: notes }
    approval: { required: above_threshold, record_threshold: 25, steps: [{ role: content_manager }] }
role_mapping:
  - { group: content, roles: [content_manager] }
  - { group: other, roles: [other_role] }
  - { group: always, roles: [always_role] }
  - { group: opaque, roles: [opaque_role] }
`,
  };
}

async function configuration(scope: string): Promise<LoadedConfiguration> {
  const loaded = await loadConfigurationSources(Object.entries(sources(scope)).map(([file, text]) => ({ file, text })));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  return loaded.configuration;
}

const CURRENT = snapshotOf(await configuration('acme, globex'));
/** The grant no longer covers the stored brand `acme` (POL-6). */
const NARROWED = snapshotOf(await configuration('globex'));

const alice: Caller = { subject: 'alice', clientId: 'aiops-mcp', groups: ['content'] };
const aliceAlways: Caller = { subject: 'alice', groups: ['always'] };
const aliceOpaque: Caller = { subject: 'alice', groups: ['opaque'] };
const bob: Caller = { subject: 'bob', groups: ['content'] };
const ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const HASH = `sha256:${'a'.repeat(64)}`;
const STALE = `sha256:${'b'.repeat(64)}`;
const NOW = new Date('2026-11-17T10:00:00.000Z');

class StubExecutor implements ChangeSetExecutor {
  readonly starts: StartRequest[] = [];
  answer: StartOutcome | 'unavailable' = { ok: true };

  start(req: StartRequest): Promise<StartOutcome> {
    this.starts.push(req);
    return this.answer === 'unavailable' ? Promise.reject(new ExecutorUnavailable()) : Promise.resolve(this.answer);
  }

  cancel(): ReturnType<ChangeSetExecutor['cancel']> {
    return Promise.reject(new Error('not used'));
  }

  wake(): Promise<void> {
    return Promise.resolve();
  }

  requestRollback(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }

  progress(): Promise<ExecutionProgress | undefined> {
    return Promise.reject(new Error('not used'));
  }
}

/** Loses the race: another submission moves the row to `pending_approval` first. */
class RacingRepository extends InMemoryChangeSetRepository {
  override async submitForApproval(req: Parameters<InMemoryChangeSetRepository['submitForApproval']>[0]): ReturnType<InMemoryChangeSetRepository['submitForApproval']> {
    const first = await super.submitForApproval(req);
    if (!first.ok) throw new Error(first.reason);
    return { ok: false, reason: 'not_prepared' };
  }
}

/** The row changed between the checks and the transaction: the transaction refuses with this reason. */
class RefusingRepository extends InMemoryChangeSetRepository {
  constructor(
    audit: InMemoryAuditLog,
    private readonly reason: 'hash_mismatch' | 'expired',
  ) {
    super(audit);
  }

  override submitForApproval(): ReturnType<InMemoryChangeSetRepository['submitForApproval']> {
    return Promise.resolve({ ok: false, reason: this.reason });
  }
}

type Stage = 'prepared' | 'pending_approval' | 'approved';

async function setup(options: { stage?: Stage; racing?: boolean; refusing?: 'hash_mismatch' | 'expired'; opaque?: boolean } = {}) {
  const opaque = options.opaque === true;
  const audit = new InMemoryAuditLog();
  const repository =
    options.racing === true
      ? new RacingRepository(audit)
      : options.refusing === undefined
        ? new InMemoryChangeSetRepository(audit)
        : new RefusingRepository(audit, options.refusing);
  const executor = new StubExecutor();
  const event = { id: 'a0', actor: 'alice', action: 'changeset.transition' as const, outcome: 'ok' as const, correlationId: 'c0', details: {} };
  await repository.create(
    {
      id: ID,
      operation: opaque ? 'notes.create' : 'catalog.update_content',
      connection: 'magento',
      requester: 'alice',
      args: opaque ? { text: 'hello' } : { brand: 'acme', skus: ['a', 'b', 'c'], changes: { name: 'New' } },
      configHash: 'h',
      correlationId: 'c0',
      createdAt: NOW,
      expiresAt: new Date('2026-11-18T10:00:00.000Z'),
    },
    event,
  );
  const targets = opaque ? ['call'] : ['a', 'b', 'c'];
  await repository.appendItems(ID, targets.map((targetId) => ({ targetId, status: 'pending' as const, before: null, after: null })));
  const count = targets.length;
  await repository.completePreparation(
    ID,
    { status: 'prepared', hash: HASH, stats: { total: count, included: count, excluded: {}, written: 0, failed: 0, skipped: 0 }, preparedAt: NOW },
    { ...event, id: 'a1' },
  );
  const stage = options.stage ?? 'prepared';
  if (stage !== 'prepared') {
    const submitted = await InMemoryChangeSetRepository.prototype.submitForApproval.call(repository, {
      changesetId: ID,
      expectedHash: HASH,
      submission: { actor: 'alice', groups: ['always'], correlationId: 'c-sub', at: NOW, role: 'always_role', rule: 'role:always_role/grant:all' },
      plan: { reason: 'role_always', steps: ['content_manager'], widget: false, included: 3 },
      audit: { transition: { ...event, id: 'a3' }, requested: { ...event, id: 'a4', action: 'approval.requested' as const } },
      notifications: [],
    });
    if (!submitted.ok) throw new Error(submitted.reason);
  }
  if (stage === 'approved') {
    const decided = await repository.recordDecision({
      changesetId: ID,
      round: 1,
      step: 1,
      record: {
        id: 'ap-1',
        changesetId: ID,
        round: 1,
        step: 1,
        role: 'content_manager',
        approver: 'dave',
        decision: 'approved',
        hash: HASH,
        itemCount: 3,
        channel: 'page',
        correlationId: 'c-dec',
        ts: NOW,
      },
      next: { kind: 'approved' },
      audit: [{ ...event, id: 'a5', action: 'approval.decision' as const }],
      notifications: [],
    });
    if (!decided.ok) throw new Error(decided.reason);
  }
  let n = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const now = () => NOW;
  const service = new SubmitService({ repository, executor, audit, newId, now, approvals: new ApprovalService({ repository, executor, audit, newId, now }) });
  const submit = (caller: Caller, opts: { id?: string; hash?: string; snapshot?: Snapshot; statuses?: readonly ('prepared' | 'approved')[] } = {}) =>
    service.submit({
      caller,
      correlationId: 'corr-5',
      changesetId: opts.id ?? ID,
      hash: opts.hash ?? HASH,
      snapshot: opts.snapshot ?? CURRENT,
      ...(opts.statuses === undefined ? {} : { statuses: opts.statuses }),
    });
  const policyRows = () => audit.events.filter((e) => e.action === 'policy.decision');
  return { repository, executor, audit, submit, policyRows };
}

describe('MCP-8 SubmitService', () => {
  it('MCP-8 POL-5 a prepared change-set needing approval answers pending_approval with the plan', async () => {
    const { submit, repository, executor, policyRows } = await setup();
    const outcome = await submit(aliceAlways);
    expect(outcome.kind).toBe('pending_approval');
    if (outcome.kind !== 'pending_approval') return;
    expect(outcome.plan).toEqual({ reason: 'role_always', steps: ['content_manager'], widget: false, included: 3 });
    // The record loaded before the change, as the tool answers it today.
    expect(outcome.changeset.status).toBe('prepared');
    expect((await repository.get(ID))?.status).toBe('pending_approval');
    expect(executor.starts).toEqual([]);
    expect(policyRows()).toHaveLength(1);
    expect(policyRows()[0]).toMatchObject({ subject: 'submit_for_approval', changesetId: ID, decision: 'allow' });
  });

  it('POL-5 an opaque change-set under above_threshold is submitted for approval', async () => {
    const { submit, repository, executor } = await setup({ opaque: true });
    const outcome = await submit(aliceOpaque);
    expect(outcome.kind).toBe('pending_approval');
    if (outcome.kind !== 'pending_approval') return;
    // One record is below the threshold of 25, but an opaque call has no record count to compare.
    expect(outcome.plan).toEqual({ reason: 'opaque', steps: ['content_manager'], widget: false, included: 1 });
    expect((await repository.get(ID))?.status).toBe('pending_approval');
    expect(executor.starts).toEqual([]);
  });

  it('MCP-8 POL-5 a prepared change-set needing no approval answers started after executor.start', async () => {
    const { submit, executor } = await setup();
    const outcome = await submit(alice);
    expect(outcome.kind).toBe('started');
    if (outcome.kind !== 'started') return;
    expect(outcome.changeset.id).toBe(ID);
    expect(executor.starts).toHaveLength(1);
    expect(executor.starts[0]).toMatchObject({ changesetId: ID, expectedHash: HASH, actor: 'alice', clientId: 'aiops-mcp', correlationId: 'corr-5' });
    expect(executor.starts[0]?.submission).toMatchObject({ role: 'content_manager', at: NOW });
  });

  it('MCP-8 SEC-9 a stale hash is refused hash_mismatch before anything changes', async () => {
    const { submit, repository, executor, policyRows } = await setup();
    expect(await submit(alice, { hash: STALE })).toEqual({ kind: 'refused', reason: 'hash_mismatch' });
    expect((await repository.get(ID))?.status).toBe('prepared');
    expect(executor.starts).toEqual([]);
    expect(policyRows()).toEqual([]);
  });

  it('MCP-8 SEC-1 a foreign or unknown change-set is refused not_found', async () => {
    const { submit, executor, policyRows } = await setup();
    expect(await submit(bob)).toEqual({ kind: 'refused', reason: 'not_found' });
    expect(await submit(alice, { id: UNKNOWN })).toEqual({ kind: 'refused', reason: 'not_found' });
    expect(executor.starts).toEqual([]);
    expect(policyRows()).toEqual([]);
  });

  it('MCP-8 POL-6 a policy denial carries the decision and leaves the change-set prepared', async () => {
    const { submit, repository, executor, policyRows } = await setup();
    const outcome = await submit(alice, { snapshot: NARROWED });
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'policy_denied', decision: { effect: 'deny' } });
    expect((await repository.get(ID))?.status).toBe('prepared');
    expect(executor.starts).toEqual([]);
    expect(policyRows()).toHaveLength(1);
  });

  it('MCP-8 an approved change-set starts through startApproved; its refusal is start_refused or executor_unavailable', async () => {
    const ok = await setup({ stage: 'approved' });
    expect(await ok.submit(alice)).toMatchObject({ kind: 'started', changeset: { id: ID, status: 'approved' } });
    // The submitted identity starts it (POL-6), not the current caller's groups.
    expect(ok.executor.starts[0]?.requester).toEqual({ subject: 'alice', groups: ['always'] });

    const refused = await setup({ stage: 'approved' });
    refused.executor.answer = { ok: false, reason: 'limit_exceeded', limit: 'records_per_day' };
    expect(await refused.submit(alice)).toEqual({
      kind: 'refused',
      reason: 'start_refused',
      role: 'always_role',
      refusal: { ok: false, reason: 'limit_exceeded', limit: 'records_per_day' },
    });

    const down = await setup({ stage: 'approved' });
    down.executor.answer = 'unavailable';
    expect(await down.submit(alice)).toEqual({ kind: 'refused', reason: 'executor_unavailable' });
  });

  it('SEC-8 MCP-8 statuses [prepared] refuses an approved change-set wrong_status and starts nothing', async () => {
    const approved = await setup({ stage: 'approved' });
    expect(await approved.submit(alice, { statuses: ['prepared'] })).toEqual({ kind: 'refused', reason: 'wrong_status', status: 'approved' });
    expect(approved.executor.starts).toEqual([]);
    expect(approved.policyRows()).toEqual([]);
    expect((await approved.repository.get(ID))?.status).toBe('approved');
    // A prepared one still goes ahead under the same option.
    const prepared = await setup();
    expect(await prepared.submit(alice, { statuses: ['prepared'] })).toMatchObject({ kind: 'started' });
  });

  it('MCP-8 wrong_status for a pending change-set; not_prepared with the current status when the submission loses the race', async () => {
    const pending = await setup({ stage: 'pending_approval' });
    expect(await pending.submit(alice)).toEqual({ kind: 'refused', reason: 'wrong_status', status: 'pending_approval' });
    expect(pending.policyRows()).toEqual([]);

    const raced = await setup({ racing: true });
    expect(await raced.submit(aliceAlways)).toEqual({ kind: 'refused', reason: 'not_prepared', status: 'pending_approval' });
  });

  it('MCP-8 SEC-9 a transaction that refuses hash_mismatch or expired after the checks passed answers raced', async () => {
    const hash = await setup({ refusing: 'hash_mismatch' });
    expect(await hash.submit(aliceAlways)).toEqual({ kind: 'refused', reason: 'hash_mismatch', raced: true });
    expect(hash.executor.starts).toEqual([]);

    const expired = await setup({ refusing: 'expired' });
    expect(await expired.submit(aliceAlways)).toEqual({ kind: 'refused', reason: 'expired', raced: true });
  });
});
