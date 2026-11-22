// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { InMemoryAuditLog } from '@mandate/testing';
import { auditedRun } from './audited-tool.js';

function deps(audit: InMemoryAuditLog) {
  let ticks = 0;
  return {
    audit,
    caller: { subject: 'alice', groups: [] },
    correlationId: 'corr-1',
    newId: () => '00000000-0000-4000-8000-000000000001',
    now: () => (ticks += 5),
  };
}

const ok = () => Promise.resolve({ content: [{ type: 'text' as const, text: 'done' }] });

describe('AUD-1 every tool call is audited before its result is returned', () => {
  it('appends one ok event, then returns the result', async () => {
    const audit = new InMemoryAuditLog();
    expect(await auditedRun('ok_tool', ok, deps(audit))).toEqual({ content: [{ type: 'text', text: 'done' }] });
    expect(audit.events).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000001',
        actor: 'alice',
        action: 'tool.call',
        subject: 'ok_tool',
        outcome: 'ok',
        correlationId: 'corr-1',
        details: { durationMs: 5 },
      },
    ]);
  });

  it('reports an error instead of the result when the audit write fails', async () => {
    const audit = new InMemoryAuditLog();
    audit.failNext = new Error('database down');
    expect(await auditedRun('ok_tool', ok, deps(audit))).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Audit unavailable; the call was not completed.' }],
    });
  });

  it('records a failing run as an error without echoing its message', async () => {
    const audit = new InMemoryAuditLog();
    const result = await auditedRun('ok_tool', () => Promise.reject(new Error('secret detail')), deps(audit));
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Tool failed.' }] });
    expect(audit.events[0]).toMatchObject({ outcome: 'error', details: { errorCode: 'handler_failed' } });
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });

  it('AUD-1 adds the details the run reports to the tool.call event', async () => {
    const audit = new InMemoryAuditLog();
    await auditedRun(
      'catalog.find',
      (report) => {
        report({ operation: 'catalog.search_products', upstreamStatus: 200 });
        return ok();
      },
      deps(audit),
    );
    expect(audit.events[0]?.details).toEqual({ operation: 'catalog.search_products', upstreamStatus: 200, durationMs: 5 });
  });
});
