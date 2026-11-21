// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { policyDecisionAuditEvent } from './policy-audit.js';

const id = '00000000-0000-4000-8000-000000000001';

describe('POL-8 decision audit event', () => {
  it('records an allow with its rule and roles', () => {
    expect(
      policyDecisionAuditEvent({
        id,
        caller: { subject: 'alice', clientId: 'aiops-mcp', groups: ['content'] },
        tool: 'catalog.search_products',
        decision: { effect: 'allow', rule: 'role:content_manager/grant:own-brands', roles: ['content_manager'] },
        correlationId: 'c1',
      }),
    ).toEqual({
      id,
      actor: 'alice',
      clientId: 'aiops-mcp',
      action: 'policy.decision',
      subject: 'catalog.search_products',
      decision: 'allow',
      outcome: 'ok',
      correlationId: 'c1',
      details: { rule: 'role:content_manager/grant:own-brands', roles: ['content_manager'] },
    });
  });

  it('records a deny with reason and detail, never argument values', () => {
    const event = policyDecisionAuditEvent({
      id,
      caller: { subject: 'alice', groups: [] },
      tool: 'catalog.search_products',
      decision: { effect: 'deny', rule: 'role:content_manager/grant:own-brands/scope:brand', reason: 'out_of_scope', detail: 'brand', roles: ['content_manager'] },
      correlationId: 'c1',
    });
    expect(event).toMatchObject({ decision: 'deny', outcome: 'denied', details: { reason: 'out_of_scope', detail: 'brand' } });
    expect(Object.keys(event)).not.toContain('clientId');
    expect(JSON.stringify(event)).not.toContain('umbrella');
  });

  it('truncates a client-supplied tool name to 128 characters', () => {
    const event = policyDecisionAuditEvent({
      id,
      caller: { subject: 'alice', groups: [] },
      tool: 'x'.repeat(300),
      decision: { effect: 'deny', rule: 'default-deny', reason: 'unknown_tool', roles: [] },
      correlationId: 'c1',
    });
    expect(event.subject).toHaveLength(128);
  });

  it('MCP-9 records the operation ID next to the called tool name', () => {
    const event = policyDecisionAuditEvent({
      id,
      caller: { subject: 'alice', groups: [] },
      tool: 'catalog.find',
      operation: 'catalog.search_products',
      decision: { effect: 'allow', rule: 'r', roles: [] },
      correlationId: 'c1',
    });
    expect(event.subject).toBe('catalog.find');
    expect(event.details).toEqual({ rule: 'r', roles: [], operation: 'catalog.search_products' });
  });
});
