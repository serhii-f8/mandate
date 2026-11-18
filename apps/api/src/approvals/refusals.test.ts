import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import type { AuditEventInput } from '@aiops/core';
import { InMemoryAuditLog } from '@aiops/testing';
import { refuse, REFUSAL_STATUS } from './refusals.js';

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
    });
  });
});
