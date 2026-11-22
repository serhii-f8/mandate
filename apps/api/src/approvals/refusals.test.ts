// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import type { AuditEventInput } from '@mandate/core';
import { InMemoryAuditLog } from '@mandate/testing';
import { pageRefuser, refuse, REFUSAL_STATUS } from './refusals.js';

const EVENT: AuditEventInput = {
  id: 'e1',
  actor: 'dave',
  action: 'approval.decision',
  outcome: 'denied',
  correlationId: 'c1',
  details: { reason: 'hash_mismatch' },
};

function fakeRes(calls: string[]): Response {
  const res = {
    status(code: number) {
      calls.push(`status:${code}`);
      return res;
    },
    json(body: unknown) {
      calls.push(`json:${JSON.stringify(body)}`);
      return res;
    },
  };
  return res as unknown as Response;
}

describe('AUD-1 refusal answers', () => {
  it('AUD-1 refuse writes the audit row before answering', async () => {
    const log = new InMemoryAuditLog();
    const calls: string[] = [];
    const append = log.append.bind(log);
    log.append = async (e) => {
      calls.push('audit');
      await append(e);
    };
    await refuse(fakeRes(calls), 'hash_mismatch', { log, event: EVENT });
    expect(log.events).toEqual([EVENT]);
    expect(calls).toEqual(['audit', 'status:409', 'json:{"error":"hash_mismatch"}']);
  });

  it('AUD-1 refuse answers nothing when the audit write fails', async () => {
    const log = new InMemoryAuditLog();
    log.failNext = new Error('db down');
    const calls: string[] = [];
    await expect(refuse(fakeRes(calls), 'csrf', { log, event: EVENT })).rejects.toThrow('db down');
    expect(calls).toEqual([]);
  });

  it('AUD-1 refuse without an audit argument only answers', async () => {
    const calls: string[] = [];
    await refuse(fakeRes(calls), 'invalid_query');
    expect(calls).toEqual(['status:400', 'json:{"error":"invalid_query"}']);
  });

  it('SEC-11 every refusal has a fixed status', () => {
    expect(REFUSAL_STATUS).toEqual({
      not_found: 404,
      csrf: 403,
      reauthentication_required: 403,
      forbidden: 403,
      not_approver: 403,
      separation_of_duties: 403,
      widget_not_allowed: 403,
      step_up_required: 403,
      not_permitted: 403,
      expired: 409,
      not_pending: 409,
      hash_mismatch: 409,
      count_mismatch: 409,
      not_approved: 409,
      not_approved_status: 409,
      limit_exceeded: 409,
      executor_unavailable: 409,
      not_executable: 409,
      invalid_body: 400,
      invalid_query: 400,
      comment_required: 400,
      comment_invalid: 400,
      not_prepared: 409,
      approval_unroutable: 409,
      empty_request: 409,
      unknown_items: 409,
      nothing_left: 409,
      not_excludable: 409,
      policy_denied: 403,
      not_rollbackable: 409,
    });
  });

  it('AUD-1 refuse adds extra fields to the answer', async () => {
    const log = new InMemoryAuditLog();
    const calls: string[] = [];
    await refuse(fakeRes(calls), 'unknown_items', { log, event: EVENT }, { count: 2 });
    expect(log.events).toEqual([EVENT]);
    expect(calls).toEqual(['status:409', 'json:{"count":2,"error":"unknown_items"}']);
    const plain: string[] = [];
    await refuse(fakeRes(plain), 'limit_exceeded', undefined, { limit: 'records_per_day' });
    expect(plain).toEqual(['status:409', 'json:{"limit":"records_per_day","error":"limit_exceeded"}']);
    const hostile: string[] = [];
    await refuse(fakeRes(hostile), 'unknown_items', undefined, { error: 'not_found' });
    expect(hostile).toEqual(['status:409', 'json:{"error":"unknown_items"}']);
  });
});

describe('AUD-1 SEC-11 page refuser', () => {
  const VIEWER = { subject: 'alice-id', clientId: 'mandate-web' };
  const ID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';

  it('AUD-1 SEC-11 pageRefuser writes one denied row with reason and channel page, then answers', async () => {
    const audit = new InMemoryAuditLog();
    const calls: string[] = [];
    const refuser = pageRefuser({ audit, action: 'changeset.export', viewer: VIEWER, id: ID, correlationId: 'c1', res: fakeRes(calls) });
    await refuser('invalid_query');
    expect(audit.events).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
        actor: 'alice-id',
        clientId: 'mandate-web',
        action: 'changeset.export',
        outcome: 'denied',
        correlationId: 'c1',
        changesetId: ID.toLowerCase(),
        subject: ID.toLowerCase(),
        details: { reason: 'invalid_query', channel: 'page' },
      },
    ]);
    expect(calls).toEqual(['status:400', 'json:{"error":"invalid_query"}']);
  });

  it('AUD-1 pageRefuser records no change-set for a path value that is not UUID-shaped', async () => {
    const audit = new InMemoryAuditLog();
    await pageRefuser({ audit, action: 'changeset.export', viewer: VIEWER, id: 'x', correlationId: 'c2', res: fakeRes([]) })('not_found');
    const [event] = audit.events;
    expect(event?.changesetId).toBeUndefined();
    expect(event?.subject).toBeUndefined();
    expect(event?.details).toEqual({ reason: 'not_found', channel: 'page' });
  });
});
