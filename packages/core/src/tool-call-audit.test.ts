// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
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

  it('records a self-declared client name in the details, never as the client ID', () => {
    const event = toolCallAuditEvent({ ...base, outcome: 'ok', declaredClientName: 'some-client' });
    expect(event.details).toEqual({ durationMs: 3, declaredClientName: 'some-client' });
    expect(Object.keys(event)).not.toContain('clientId');
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

  it('AUD-1 MCP-9 merges extra details such as the operation ID and the upstream status', () => {
    const event = toolCallAuditEvent({
      ...base,
      tool: 'catalog.find',
      outcome: 'ok',
      details: { operation: 'catalog.search_products', connection: 'magento', upstreamStatus: 200, itemCount: 2, upstreamMs: 7 },
    });
    expect(event.subject).toBe('catalog.find');
    expect(event.details).toEqual({ operation: 'catalog.search_products', connection: 'magento', upstreamStatus: 200, itemCount: 2, upstreamMs: 7, durationMs: 3 });
  });

  it('AUD-1 keeps its own duration and drops an extra error code from an ok call', () => {
    const event = toolCallAuditEvent({ ...base, outcome: 'ok', details: { durationMs: 999, errorCode: 'x' } });
    expect(event.details).toEqual({ durationMs: 3 });
    const failed = toolCallAuditEvent({ ...base, outcome: 'error', details: { errorCode: 'http_status' } });
    expect(failed.details).toEqual({ durationMs: 3, errorCode: 'http_status' });
    const own = toolCallAuditEvent({ ...base, outcome: 'error', errorCode: 'handler_failed', details: { errorCode: 'http_status' } });
    expect(own.details).toEqual({ durationMs: 3, errorCode: 'handler_failed' });
  });

  it('AUD-1 ignores a declared client name passed as an extra detail', () => {
    expect(toolCallAuditEvent({ ...base, outcome: 'ok', details: { declaredClientName: 'spoofed' } }).details).toEqual({ durationMs: 3 });
    expect(toolCallAuditEvent({ ...base, outcome: 'ok', declaredClientName: 'real', details: { declaredClientName: 'spoofed' } }).details).toEqual({ durationMs: 3, declaredClientName: 'real' });
  });
});
