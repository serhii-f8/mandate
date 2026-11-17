import { randomUUID } from 'node:crypto';
import type { LoadedConfiguration } from '@aiops/config';
import { DrizzleAuditLog, PostgresChangeSetRepository } from '@aiops/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExecutionGuard } from '../../src/activities/guard.js';
import { createPrepared } from '../support/changesets.js';
import { testConfiguration } from '../support/configuration.js';
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

  it('POL-6 the production guard denies a change-set without an execution request', async () => {
    const cs = await createPrepared(repository, 1);
    await expect(guardFor(configuration).check(cs)).resolves.toEqual({ ok: false, outcome: 'policy_denied' });
  });
});
