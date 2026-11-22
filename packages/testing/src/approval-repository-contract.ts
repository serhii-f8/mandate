// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { startEventFactory } from '@mandate/core';
import type { AuditEventInput, ChangeSetRecord, ChangeSetRepository } from '@mandate/core';
import { recordApproval, submitChangeSet } from './approval-fixtures.js';
import type { ChangeSetRepositoryHarness } from './changeset-repository-contract.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-02T00:00:00.000Z');
const HASH = 'h';

/** Behavior every ChangeSetRepository implementation must have for approvals (APR-1, APR-3, APR-4, SEC-9, POL-6). */
export function describeApprovalRepositoryContract(label: string, setup: () => Promise<ChangeSetRepositoryHarness>): void {
  describe(`${label} APR-1 APR-3 SEC-9 approval repository`, () => {
    interface Ctx extends ChangeSetRepositoryHarness {
      readonly id: string;
      readonly events: () => Promise<readonly AuditEventInput[]>;
    }

    async function withRepo(body: (c: Ctx) => Promise<void>): Promise<void> {
      const h = await setup();
      const id = randomUUID();
      try {
        await body({ ...h, id, events: async () => (await h.auditEvents()).filter((e) => e.changesetId === id) });
      } finally {
        await h.close?.();
      }
    }

    function auditEvent(id: string): AuditEventInput {
      return {
        id: randomUUID(),
        actor: 'alice',
        action: 'changeset.transition',
        outcome: 'ok',
        correlationId: 'corr-1',
        changesetId: id,
        details: {},
      };
    }

    /** A fresh prepared change-set with two included items. */
    async function prepared(c: Ctx, over: { expiresAt?: Date } = {}): Promise<ChangeSetRecord> {
      await c.repository.create(
        {
          id: c.id,
          operation: 'catalog.update',
          connection: 'shop',
          requester: 'alice',
          args: { sku: 'a' },
          configHash: 'cfg',
          correlationId: 'corr-1',
          createdAt: NOW,
          expiresAt: over.expiresAt ?? LATER,
        },
        auditEvent(c.id),
      );
      await c.repository.appendItems(c.id, [
        { targetId: 't-1', status: 'pending', before: { v: 1 }, after: { v: 2 } },
        { targetId: 't-2', status: 'pending', before: { v: 1 }, after: { v: 2 } },
      ]);
      const record = await c.repository.completePreparation(
        c.id,
        { status: 'prepared', hash: HASH, stats: await c.repository.stats(c.id), preparedAt: NOW },
        auditEvent(c.id),
      );
      if (record === undefined) throw new Error('preparation failed');
      return record;
    }

    async function current(c: Ctx): Promise<ChangeSetRecord> {
      const record = await c.repository.get(c.id);
      if (record === undefined) throw new Error('missing change-set');
      return record;
    }

    function start(c: Ctx, expectedHash = HASH): ReturnType<ChangeSetRepository['startExecution']> {
      const actor = { actor: 'alice', groups: [] as string[], correlationId: 'corr-x' };
      return c.repository.startExecution({
        changesetId: c.id,
        expectedHash,
        request: actor,
        now: NOW,
        event: startEventFactory({ newId: randomUUID, ...actor }),
      });
    }

    function submitArgs(
      c: Ctx,
      hash: string,
    ): Parameters<ChangeSetRepository['submitForApproval']>[0] {
      const correlationId = 'corr-s';
      const base = { id: randomUUID(), actor: 'alice', correlationId, changesetId: c.id, outcome: 'ok' as const };
      return {
        changesetId: c.id,
        expectedHash: hash,
        submission: { actor: 'alice', groups: [], correlationId, at: NOW, role: 'writer', rule: 'role:writer/approval' },
        plan: { reason: 'default', steps: ['lead'], widget: false, included: 2 },
        audit: {
          transition: { ...base, action: 'changeset.transition', details: { from: 'prepared', to: 'pending_approval' } },
          requested: { ...base, id: randomUUID(), action: 'approval.requested', details: { round: 1, step: 1 } },
        },
        notifications: [],
      };
    }

    it('submitForApproval moves prepared to pending_approval with round 1, submission, plan, awaitingRole and two audit events', async () =>
      withRepo(async (c) => {
        const cs = await prepared(c);
        const before = (await c.events()).length;
        const submitted = await submitChangeSet(c.repository, cs, { steps: ['lead', 'brand'], groups: ['g1'], at: NOW });
        for (const rec of [submitted, await current(c)]) {
          expect(rec.status).toBe('pending_approval');
          expect(rec.approvalRound).toBe(1);
          expect(rec.awaitingRole).toBe('lead');
          expect(rec.approvalPlan?.steps).toEqual(['lead', 'brand']);
          expect(rec.approvalPlan?.included).toBe(2);
          expect(rec.submission?.actor).toBe('alice');
          expect(rec.submission?.groups).toEqual(['g1']);
          expect(rec.submission?.at).toBeInstanceOf(Date);
          expect(rec.submission?.at.getTime()).toBe(NOW.getTime());
        }
        const added = (await c.events()).slice(before);
        expect(added.map((e) => e.action).sort()).toEqual(['approval.requested', 'changeset.transition']);
      }));

    it('submitForApproval refuses not_found, hash_mismatch, not_prepared, and expired (CAS to expired) and changes nothing else', async () =>
      withRepo(async (c) => {
        expect(await c.repository.submitForApproval(submitArgs(c, HASH))).toEqual({ ok: false, reason: 'not_found' });
        await prepared(c);
        const before = (await c.events()).length;
        expect(await c.repository.submitForApproval(submitArgs(c, 'other'))).toEqual({ ok: false, reason: 'hash_mismatch' });
        expect((await current(c)).status).toBe('prepared');
        expect((await c.events()).length).toBe(before);
        await c.repository.transition(c.id, ['prepared'], 'cancelled', auditEvent(c.id));
        expect(await c.repository.submitForApproval(submitArgs(c, HASH))).toEqual({ ok: false, reason: 'not_prepared' });
        expect((await current(c)).status).toBe('cancelled');
        expect((await current(c)).approvalRound).toBe(0);
      }));

    it('submitForApproval refuses an expired change-set and moves it to expired without an approval event', async () =>
      withRepo(async (c) => {
        await prepared(c, { expiresAt: NOW });
        const args = submitArgs(c, HASH);
        const result = await c.repository.submitForApproval(args);
        expect(result).toEqual({ ok: false, reason: 'expired' });
        const rec = await current(c);
        expect(rec.status).toBe('expired');
        expect(rec.approvalRound).toBe(0);
        expect(rec.approvalPlan).toBeUndefined();
        expect((await c.events()).map((e) => e.action)).not.toContain('approval.requested');
      }));

    it('APR-3 a two-step chain: step 1 approve gives next_step awaitingRole brand, step 2 approve gives approved with awaitingRole unset', async () =>
      withRepo(async (c) => {
        const submitted = await submitChangeSet(c.repository, await prepared(c), { steps: ['lead', 'brand'], at: NOW });
        const afterFirst = await recordApproval(c.repository, submitted, { approver: 'bob' });
        expect(afterFirst.status).toBe('pending_approval');
        expect(afterFirst.awaitingRole).toBe('brand');
        const afterSecond = await recordApproval(c.repository, afterFirst, { approver: 'carol' });
        expect(afterSecond.status).toBe('approved');
        expect(afterSecond.awaitingRole).toBeUndefined();
        expect((await current(c)).awaitingRole).toBeUndefined();
        const rows = await c.repository.approvals(c.id);
        expect(rows.map((r) => [r.round, r.step, r.role, r.approver, r.decision])).toEqual([
          [1, 1, 'lead', 'bob', 'approved'],
          [1, 2, 'brand', 'carol', 'approved'],
        ]);
      }));

    it('APR-4 return moves to prepared, clears awaitingRole, keeps the round; a resubmission starts round 2', async () =>
      withRepo(async (c) => {
        const submitted = await submitChangeSet(c.repository, await prepared(c), { at: NOW });
        const returned = await recordApproval(c.repository, submitted, { approver: 'bob', decision: 'returned', comment: 'fix' });
        expect(returned.status).toBe('prepared');
        expect(returned.awaitingRole).toBeUndefined();
        expect(returned.approvalRound).toBe(1);
        const again = await submitChangeSet(c.repository, returned, { at: NOW });
        expect(again.approvalRound).toBe(2);
        expect(again.status).toBe('pending_approval');
        expect(await c.repository.approvals(c.id, 2)).toEqual([]);
        const round1 = await c.repository.approvals(c.id);
        expect(round1).toHaveLength(1);
        expect(round1[0]?.round).toBe(1);
        expect(round1[0]?.decision).toBe('returned');
      }));

    it('APR-3 reject moves to rejected', async () =>
      withRepo(async (c) => {
        const submitted = await submitChangeSet(c.repository, await prepared(c), { at: NOW });
        const rejected = await recordApproval(c.repository, submitted, { approver: 'bob', decision: 'rejected' });
        expect(rejected.status).toBe('rejected');
        expect(rejected.awaitingRole).toBeUndefined();
        expect((await c.repository.approvals(c.id))[0]?.decision).toBe('rejected');
      }));

    it('APR-3 recordDecision refuses not_pending for a wrong round, a wrong step, or a change-set no longer pending_approval, and stores nothing', async () =>
      withRepo(async (c) => {
        const submitted = await submitChangeSet(c.repository, await prepared(c), { steps: ['lead', 'brand'], at: NOW });
        const stale = { ...submitted };
        async function attempt(over: { round?: number; step?: number }): Promise<unknown> {
          const record = {
            id: randomUUID(),
            changesetId: c.id,
            round: over.round ?? 1,
            step: over.step ?? 1,
            role: 'lead',
            approver: 'bob',
            decision: 'approved' as const,
            hash: HASH,
            itemCount: 2,
            channel: 'page' as const,
            correlationId: 'corr-d',
            ts: NOW,
          };
          return c.repository.recordDecision({
            changesetId: c.id,
            round: record.round,
            step: record.step,
            record,
            next: { kind: 'next_step', awaitingRole: 'brand' },
            audit: [auditEvent(c.id)],
            notifications: [],
          });
        }
        expect(await attempt({ round: 2 })).toEqual({ ok: false, reason: 'not_pending' });
        expect(await attempt({ step: 2 })).toEqual({ ok: false, reason: 'not_pending' });
        await c.repository.transition(c.id, ['pending_approval'], 'cancelled', auditEvent(c.id));
        expect(await attempt({})).toEqual({ ok: false, reason: 'not_pending' });
        expect(stale.status).toBe('pending_approval');
        expect(await c.repository.approvals(c.id)).toEqual([]);
        expect((await current(c)).status).toBe('cancelled');
      }));

    it('APR-3 concurrent recordDecision for the same step: exactly one ok', async () =>
      withRepo(async (c) => {
        const submitted = await submitChangeSet(c.repository, await prepared(c), { at: NOW });
        const results = await Promise.allSettled([
          recordApproval(c.repository, submitted, { approver: 'bob' }),
          recordApproval(c.repository, submitted, { approver: 'carol' }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const lost = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []));
        expect(lost).toHaveLength(1);
        expect(lost[0]).toContain('not_pending');
        expect(await c.repository.approvals(c.id)).toHaveLength(1);
        const approvedEvents = (await c.events()).filter((e) => e.action === 'changeset.transition' && e.details.to === 'approved');
        expect(approvedEvents).toHaveLength(1);
        expect((await current(c)).status).toBe('approved');
      }));

    describe('SEC-9 startExecution from approved checks the current round', () => {
      it('SEC-9 approved by transition only (no rows) gives not_approved', async () =>
        withRepo(async (c) => {
          await submitChangeSet(c.repository, await prepared(c), { at: NOW });
          await c.repository.transition(c.id, ['pending_approval'], 'approved', auditEvent(c.id));
          expect(await start(c)).toEqual({ ok: false, reason: 'not_approved' });
          expect((await current(c)).status).toBe('approved');
        }));

      it('SEC-9 all steps approved for the hash gives ok', async () =>
        withRepo(async (c) => {
          let cs = await submitChangeSet(c.repository, await prepared(c), { steps: ['lead', 'brand'], at: NOW });
          cs = await recordApproval(c.repository, cs, { approver: 'bob' });
          await recordApproval(c.repository, cs, { approver: 'carol' });
          const result = await start(c);
          expect(result.ok).toBe(true);
          expect((await current(c)).status).toBe('executing');
        }));

      it('SEC-9 a row whose hash differs from expectedHash gives not_approved', async () =>
        withRepo(async (c) => {
          const cs = await submitChangeSet(c.repository, await prepared(c), { at: NOW });
          await recordApproval(c.repository, cs, { approver: 'bob', hash: 'sha256:other' });
          expect((await current(c)).status).toBe('approved');
          expect(await start(c)).toEqual({ ok: false, reason: 'not_approved' });
          expect((await current(c)).status).toBe('approved');
        }));

      it('APR-4 SEC-9 round-1 approvals after a resubmission give not_approved', async () =>
        withRepo(async (c) => {
          let cs = await submitChangeSet(c.repository, await prepared(c), { steps: ['lead', 'brand'], at: NOW });
          cs = await recordApproval(c.repository, cs, { approver: 'bob' });
          cs = await recordApproval(c.repository, cs, { approver: 'carol', decision: 'returned' });
          cs = await submitChangeSet(c.repository, cs, { steps: ['lead'], at: NOW });
          expect(cs.approvalRound).toBe(2);
          await c.repository.transition(c.id, ['pending_approval'], 'approved', auditEvent(c.id));
          expect(await start(c)).toEqual({ ok: false, reason: 'not_approved' });
        }));
    });

    it('POL-6 startExecution from prepared stores the submission', async () =>
      withRepo(async (c) => {
        await prepared(c);
        const actor = { actor: 'alice', groups: [] as string[], correlationId: 'corr-x' };
        const result = await c.repository.startExecution({
          changesetId: c.id,
          expectedHash: HASH,
          request: actor,
          submission: { ...actor, at: NOW, role: 'writer', rule: 'role:writer/approval' },
          now: NOW,
          event: startEventFactory({ newId: randomUUID, ...actor }),
        });
        expect(result.ok).toBe(true);
        const rec = await current(c);
        expect(rec.status).toBe('executing');
        expect(rec.submission?.role).toBe('writer');
        expect(rec.submission?.rule).toBe('role:writer/approval');
        expect(rec.submission?.at.getTime()).toBe(NOW.getTime());
      }));

    it('APR-1 APR-3 a failing audit append rolls back submitForApproval and recordDecision', async () =>
      withRepo(async (c) => {
        const cs = await prepared(c);
        c.failNextAudit();
        await expect(submitChangeSet(c.repository, cs, { at: NOW })).rejects.toThrow();
        const afterSubmit = await current(c);
        expect(afterSubmit.status).toBe('prepared');
        expect(afterSubmit.approvalRound).toBe(0);
        expect(afterSubmit.approvalPlan).toBeUndefined();
        const submitted = await submitChangeSet(c.repository, cs, { at: NOW });
        c.failNextAudit();
        await expect(recordApproval(c.repository, submitted, { approver: 'bob' })).rejects.toThrow();
        expect((await current(c)).status).toBe('pending_approval');
        expect(await c.repository.approvals(c.id)).toEqual([]);
      }));
  });
}
