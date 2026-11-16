import { describe, expect, it } from 'vitest';
import { ANONYMOUS_CALLER, type Caller } from './caller.js';
import { toolCallAuditEvent } from './tool-call-audit.js';

const base = {
  id: '00000000-0000-4000-8000-000000000001',
  caller: ANONYMOUS_CALLER,
  tool: 'ping',
  correlationId: 'corr-1',
  durationMs: 3,
} as const;

describe('AUD-1 tool call audit event', () => {
  it('records actor, action, tool, outcome and correlation ID', () => {
    expect(toolCallAuditEvent({ ...base, outcome: 'ok' })).toEqual({
      id: base.id,
      actor: 'anonymous',
      action: 'tool.call',
      subject: 'ping',
      outcome: 'ok',
      correlationId: 'corr-1',
      details: { durationMs: 3 },
    });
  });

  it('omits the client ID when the caller has none', () => {
    expect(Object.keys(toolCallAuditEvent({ ...base, outcome: 'ok' }))).not.toContain('clientId');
  });

  it('carries the client ID when the caller has one', () => {
    const caller: Caller = { subject: 'alice', clientId: 'claude-ai', groups: ['content'] };
    expect(toolCallAuditEvent({ ...base, caller, outcome: 'ok' })).toMatchObject({ actor: 'alice', clientId: 'claude-ai' });
  });

  it('adds the error code to the details only for an error', () => {
    expect(toolCallAuditEvent({ ...base, outcome: 'error', errorCode: 'handler_failed' }).details).toEqual({
      durationMs: 3,
      errorCode: 'handler_failed',
    });
    expect(toolCallAuditEvent({ ...base, outcome: 'ok', errorCode: 'ignored' }).details).toEqual({ durationMs: 3 });
  });

  it('never records call arguments (SEC-3: they may carry sensitive data)', () => {
    const event = toolCallAuditEvent({ ...base, outcome: 'ok' });
    expect(JSON.stringify(event)).not.toMatch(/argument/i);
  });
});
