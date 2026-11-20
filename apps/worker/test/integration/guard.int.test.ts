import { randomUUID } from 'node:crypto';
import type { LoadedConfiguration } from '@aiops/config';
import type { RoleApprovalRule } from '@aiops/core';
import { DrizzleAuditLog, PostgresChangeSetRepository } from '@aiops/db';
import { recordApproval, submitChangeSet } from '@aiops/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExecutionGuard } from '../../src/activities/guard.js';
import { createPrepared, startExecutionOf } from '../support/changesets.js';
import { APPROVING_GROUP, EDITOR_GROUP, testConfiguration } from '../support/configuration.js';
import { createPreparedOpaque } from '../support/opaque.js';
import { auditEventsOf, startTestPostgres, type TestPostgres } from '../support/postgres.js';

let postgres: TestPostgres;
let repository: PostgresChangeSetRepository;
let configuration: LoadedConfiguration;
let guardFor: ReturnType<typeof createExecutionGuard>;

beforeAll(async () => {
  postgres = await startTestPostgres();
  repository = new PostgresChangeSetRepository(postgres.database.db);
  configuration = await testConfiguration();
  guardFor = createExecutionGuard({ repository, audit: new DrizzleAuditLog(postgres.database.db), newId: randomUUID });
});

afterAll(async () => {
  await postgres.stop();
});

describe('production execution guard', () => {
  it('CS-4 POL-6 the production guard accepts an unchanged change-set whose requester is still allowed', async () => {
    const cs = await createPrepared(repository, 3, { execute: { groups: ['editors'] } });
    await expect(guardFor(configuration).check(cs)).resolves.toEqual({ ok: true });
    expect((await auditEventsOf(postgres.database, cs.id)).filter((e) => e.action === 'policy.decision')).toEqual([]);
  });

  it('CS-4 the production guard reports hash_mismatch when stored items no longer hash to the stored hash', async () => {
    const cs = await createPrepared(repository, 3, { hash: '0'.repeat(64), execute: { groups: ['editors'] } });
    await expect(guardFor(configuration).check(cs)).resolves.toEqual({ ok: false, outcome: 'hash_mismatch' });
  });

  it('POL-6 the production guard denies when the stored groups no longer grant the operation and audits the decision', async () => {
    const cs = await createPrepared(repository, 3, { execute: { actor: 'alice', groups: ['nobody'], correlationId: 'corr-exec-denied' } });
    await expect(guardFor(configuration).check(cs)).resolves.toEqual({ ok: false, outcome: 'policy_denied' });
    const decisions = (await auditEventsOf(postgres.database, cs.id)).filter((e) => e.action === 'policy.decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      actor: 'alice',
      decision: 'deny',
      outcome: 'denied',
      correlationId: 'corr-exec-denied',
      changesetId: cs.id,
      details: { rule: 'default-deny', operation: cs.operation },
    });
  });

  it('AUTH-4 EXE re-authorisation uses the service account role of the stored requester', async () => {
    // The service account holds `editor` (no approval, grants the operation on brand acme); its groups are empty.
    const withServiceAccount: LoadedConfiguration = {
      ...configuration,
      serviceAccounts: new Map([['aiops-sa-ci', { role: 'editor' }]]),
      policy: { ...configuration.policy, serviceAccounts: [{ clientId: 'aiops-sa-ci', role: 'editor' }] },
    };
    const cs = await createPrepared(repository, 3, {
      requester: 'service:aiops-sa-ci',
      execute: { actor: 'service:aiops-sa-ci', groups: [], clientId: 'aiops-sa-ci', correlationId: 'corr-exec-service' },
    });
    await expect(guardFor(withServiceAccount).check(cs)).resolves.toEqual({ ok: true });
    // A reload without the service_accounts entry leaves the subject without a role.
    expect(configuration.policy.serviceAccounts ?? []).toEqual([]);
    await expect(guardFor(configuration).check(cs)).resolves.toEqual({ ok: false, outcome: 'policy_denied' });
    const decisions = (await auditEventsOf(postgres.database, cs.id)).filter((e) => e.action === 'policy.decision');
    expect(decisions).toMatchObject([{ actor: 'service:aiops-sa-ci', clientId: 'aiops-sa-ci', decision: 'deny', details: { rule: 'default-deny' } }]);
  });

  it('POL-6 the production guard denies a change-set without an execution request', async () => {
    const cs = await createPrepared(repository, 1);
    await expect(guardFor(configuration).check(cs)).resolves.toEqual({ ok: false, outcome: 'policy_denied' });
  });
});

/**
 * Roles of the test configuration: `approving_editor` (group `approving-editors`) needs one
 * `reviewer` approval for every change-set (POL-5); `editor` needs none.
 */
describe('execution guard approval re-check', () => {
  const requester = { actor: 'alice', groups: [APPROVING_GROUP] };

  /** The test configuration with one role's approval rule replaced (undefined removes it), as a reload would. */
  function withApprovalRule(
    role: string,
    change: (rule: RoleApprovalRule) => RoleApprovalRule | undefined,
  ): LoadedConfiguration {
    const current = configuration.approval.get(role);
    if (current === undefined) throw new Error(`no approval rule for ${role}`);
    const next = change(current);
    const approval = new Map(configuration.approval);
    if (next === undefined) approval.delete(role);
    else approval.set(role, next);
    return { ...configuration, approval };
  }

  it('POL-5 SEC-9 a change-set of a role that requires approval passes with an approved row carrying the recomputed hash', async () => {
    const prepared = await createPrepared(repository, 3);
    const submitted = await submitChangeSet(repository, prepared, { steps: ['reviewer'], groups: [APPROVING_GROUP] });
    const approved = await recordApproval(repository, submitted, { approver: 'rita' });
    expect(approved.status).toBe('approved');
    const cs = await startExecutionOf(repository, approved, requester);
    await expect(guardFor(configuration).check(cs)).resolves.toEqual({ ok: true });
  });

  it('POL-5 a change-set started without approval for a role that now requires it fails approval_missing', async () => {
    const cs = await createPrepared(repository, 3, { execute: { groups: [APPROVING_GROUP] } });
    await expect(guardFor(configuration).check(cs)).resolves.toEqual({ ok: false, outcome: 'approval_missing' });
  });

  it('SEC-9 an approval row for another hash is approval_missing', async () => {
    // The repository refuses to start an approved change-set whose rows carry another hash
    // (not_approved), so the guard sees the approved record with the execution request attached.
    const prepared = await createPrepared(repository, 3);
    const submitted = await submitChangeSet(repository, prepared, { steps: ['reviewer'], groups: [APPROVING_GROUP] });
    const approved = await recordApproval(repository, submitted, { approver: 'rita', hash: 'f'.repeat(64) });
    expect(approved.status).toBe('approved');
    const cs = { ...approved, executionRequest: { ...requester, correlationId: 'corr-exec', startedAt: new Date() } };
    await expect(guardFor(configuration).check(cs)).resolves.toEqual({ ok: false, outcome: 'approval_missing' });
    // Control: the same record with a row for its hash passes.
    const good = await recordApproval(
      repository,
      await submitChangeSet(repository, await createPrepared(repository, 3), { steps: ['reviewer'], groups: [APPROVING_GROUP] }),
      { approver: 'rita' },
    );
    const goodCs = { ...good, executionRequest: { ...requester, correlationId: 'corr-exec', startedAt: new Date() } };
    await expect(guardFor(configuration).check(goodCs)).resolves.toEqual({ ok: true });
  });

  it('APR-4 a current round that was returned counts as having no approvals', async () => {
    // reviewer approves step 1 for the right hash, the second step returns it to prepared (round 1 stays).
    const prepared = await createPrepared(repository, 3);
    const submitted = await submitChangeSet(repository, prepared, { steps: ['reviewer', 'lead'], groups: [APPROVING_GROUP] });
    const afterStep1 = await recordApproval(repository, submitted, { approver: 'rita' });
    const returned = await recordApproval(repository, afterStep1, { approver: 'larry', decision: 'returned', comment: 'later' });
    expect(returned).toMatchObject({ status: 'prepared', approvalRound: 1 });
    expect((await repository.approvals(returned.id, 1)).map((r) => [r.role, r.decision])).toEqual([
      ['reviewer', 'approved'],
      ['lead', 'returned'],
    ]);
    const cs = await startExecutionOf(repository, returned, requester);
    await expect(guardFor(configuration).check(cs)).resolves.toEqual({ ok: false, outcome: 'approval_missing' });
  });

  it('POL-5 SEC-9 a repeated step role needs one approved row per occurrence', async () => {
    const prepared = await createPrepared(repository, 3);
    const submitted = await submitChangeSet(repository, prepared, { steps: ['reviewer'], groups: [APPROVING_GROUP] });
    const cs = await startExecutionOf(repository, await recordApproval(repository, submitted, { approver: 'rita' }), requester);
    await expect(guardFor(configuration).check(cs)).resolves.toEqual({ ok: true });
    const tightened = withApprovalRule('approving_editor', (rule) => ({ ...rule, steps: ['reviewer', 'reviewer'] }));
    await expect(guardFor(tightened).check(cs)).resolves.toEqual({ ok: false, outcome: 'approval_missing' });
  });

  it('POL-5 SEC-11 a required approval without configured steps is approval_missing', async () => {
    // The role lost its approval rule: approval is required by default and nobody can approve it.
    const prepared = await createPrepared(repository, 3);
    const submitted = await submitChangeSet(repository, prepared, { steps: ['reviewer'], groups: [APPROVING_GROUP] });
    const cs = await startExecutionOf(repository, await recordApproval(repository, submitted, { approver: 'rita' }), requester);
    const unroutable = withApprovalRule('approving_editor', () => undefined);
    await expect(guardFor(unroutable).check(cs)).resolves.toEqual({ ok: false, outcome: 'approval_missing' });
  });

  it('APR-4 approvals of an earlier round do not count', async () => {
    // Round 1: reviewer approves with the right hash, then step 2 returns it. Round 2: returned at step 1.
    const prepared = await createPrepared(repository, 3);
    const round1 = await submitChangeSet(repository, prepared, { steps: ['reviewer', 'lead'], groups: [APPROVING_GROUP] });
    const afterStep1 = await recordApproval(repository, round1, { approver: 'rita' });
    const returned1 = await recordApproval(repository, afterStep1, { approver: 'larry', decision: 'returned', comment: 'later' });
    const round2 = await submitChangeSet(repository, returned1, { steps: ['reviewer'], groups: [APPROVING_GROUP] });
    const returned2 = await recordApproval(repository, round2, { approver: 'rita', decision: 'returned', comment: 'again' });
    expect(returned2).toMatchObject({ status: 'prepared', approvalRound: 2 });
    const cs = await startExecutionOf(repository, returned2, requester);
    await expect(guardFor(configuration).check(cs)).resolves.toEqual({ ok: false, outcome: 'approval_missing' });
  });

  it('POL-5 an opaque change-set whose role moved from never to above_threshold after submission is refused without approvals', async () => {
    // Started by an editor while the role needed no approval: no approval rows exist.
    const cs = await createPreparedOpaque(repository, { execute: { groups: [EDITOR_GROUP] } });
    expect(cs.stats.included).toBe(1);
    await expect(guardFor(configuration).check(cs)).resolves.toEqual({ ok: true });
    // A reload moves the role to above_threshold: one record is far below 25, but an opaque call has no count to compare.
    const tightened = withApprovalRule('editor', (rule) => ({ ...rule, required: 'above_threshold', recordThreshold: 25, steps: ['reviewer'] }));
    await expect(guardFor(tightened).check(cs)).resolves.toEqual({ ok: false, outcome: 'approval_missing' });
  });

  it('CS-4 a tampered item is hash_mismatch before the approval check', async () => {
    const cs = await createPrepared(repository, 3, { hash: '0'.repeat(64), execute: { groups: [APPROVING_GROUP] } });
    await expect(guardFor(configuration).check(cs)).resolves.toEqual({ ok: false, outcome: 'hash_mismatch' });
  });
});
