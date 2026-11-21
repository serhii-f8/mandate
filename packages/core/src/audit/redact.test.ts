// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { ANONYMOUS_CALLER } from '../caller.js';
import { changesetTransitionEvent } from '../changeset/audit.js';
import { policyDecisionAuditEvent } from '../policy-audit.js';
import { toolCallAuditEvent } from '../tool-call-audit.js';
import { AuditRedactionError, REDACTED, redactAuditDetails } from './redact.js';

const none: ReadonlySet<string> = new Set();

describe('AUD-4 SEC-3 audit redaction', () => {
  it.each(['password', 'pass', 'clientSecret', 'accessToken', 'Authorization', 'authorisation', 'apiKey', 'api_key', 'api-key', 'credential', 'Cookie'])(
    'AUD-4 key %s is redacted at depth 0, at depth 3 and inside an array element',
    (key) => {
      expect(redactAuditDetails({ [key]: 'v', keep: 1 }, none)).toEqual({ [key]: REDACTED, keep: 1 });
      expect(redactAuditDetails({ a: { b: { c: { [key]: 'v', keep: 1 } } } }, none)).toEqual({ a: { b: { c: { [key]: REDACTED, keep: 1 } } } });
      expect(redactAuditDetails({ list: [{ [key]: 'v' }, 2] }, none)).toEqual({ list: [{ [key]: REDACTED }, 2] });
      expect(redactAuditDetails({ [key]: { nested: 'v', list: [1] } }, none)).toEqual({ [key]: REDACTED });
    },
  );

  it('AUD-4 bearer and JWT-shaped strings are redacted wherever they are', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
    expect(
      redactAuditDetails({ a: 'Bearer abc', b: 'bearer abc', c: jwt, d: { e: [jwt, 'Bearer abc'] }, f: 'eyJ-only-one-segment', g: 'Bearer-like' }, none),
    ).toEqual({ a: REDACTED, b: REDACTED, c: REDACTED, d: { e: [REDACTED, REDACTED] }, f: 'eyJ-only-one-segment', g: 'Bearer-like' });
    expect(REDACTED).toBe('[redacted]');
  });

  it('AUD-4 manifest sensitive keys match exactly', () => {
    expect(redactAuditDetails({ fields: { cost: 5, costs: 1, Cost: 2 } }, new Set(['cost']))).toEqual({
      fields: { cost: '[redacted]', costs: 1, Cost: 2 },
    });
  });

  it('AUD-4 existing audit details pass unchanged', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const inputs: Record<string, unknown>[] = [
      { ref: 'magento-integration', scheme: 'bearer', keyVersion: 2 },
      { errorCode: 'credential_unusable', reason: 'invalid_token', fresh: true, authTime: '2026-11-18T10:00:00.000Z' },
      { ...toolCallAuditEvent({ id, caller: ANONYMOUS_CALLER, tool: 'ping', correlationId: 'corr-1', durationMs: 3, outcome: 'ok' }).details },
      {
        ...toolCallAuditEvent({
          id,
          caller: ANONYMOUS_CALLER,
          tool: 'catalog.find',
          correlationId: 'corr-1',
          durationMs: 3,
          outcome: 'error',
          errorCode: 'handler_failed',
          declaredClientName: 'some-client',
          details: { operation: 'catalog.search_products', connection: 'magento', upstreamStatus: 200, itemCount: 2, upstreamMs: 7 },
        }).details,
      },
      {
        ...policyDecisionAuditEvent({
          id,
          caller: { subject: 'alice', clientId: 'aiops-mcp', groups: ['content'] },
          tool: 'catalog.search_products',
          decision: { effect: 'allow', rule: 'role:content_manager/grant:own-brands', roles: ['content_manager'] },
          correlationId: 'c1',
        }).details,
      },
      {
        ...policyDecisionAuditEvent({
          id,
          caller: { subject: 'alice', groups: [] },
          tool: 'catalog.find',
          operation: 'catalog.search_products',
          decision: { effect: 'deny', rule: 'role:content_manager/grant:own-brands/scope:brand', reason: 'out_of_scope', detail: 'brand', roles: ['content_manager'] },
          correlationId: 'c1',
        }).details,
      },
      {
        ...changesetTransitionEvent({
          id: 'e1',
          actor: 'alice',
          clientId: 'c',
          changeset: { id: 'cs1', operation: 'catalog.update_content' },
          from: 'prepared',
          to: 'executing',
          correlationId: 'corr',
          details: { items: 3 },
        }).details,
      },
      {
        ...changesetTransitionEvent({
          id: 'e1',
          actor: 'alice',
          changeset: { id: 'cs1', operation: 'catalog.update_content' },
          from: null,
          to: 'failed',
          correlationId: 'corr',
        }).details,
      },
    ];
    for (const details of inputs) {
      expect(redactAuditDetails(details, none)).toEqual(details);
    }
  });

  it('AUD-4 the input is not mutated', () => {
    const input = { token: 'x', nested: { password: 'p', list: [{ apiKey: 'k' }, 'Bearer abc'] }, keep: 1 };
    const snapshot = structuredClone(input);
    const out = redactAuditDetails(input, none);
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect(out.nested).not.toBe(input.nested);
  });

  it('AUD-4 non-plain objects are kept as they are', () => {
    const date = new Date('2026-11-18T10:00:00.000Z');
    const bare: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    bare.secret = 's';
    const out = redactAuditDetails({ date, bare }, none);
    expect(out.date).toBe(date);
    expect(out.bare).toEqual({ secret: REDACTED });
  });

  it('AUD-4 a cycle throws AuditRedactionError, a shared reference does not', () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = { back: loop };
    expect(() => redactAuditDetails(loop, none)).toThrow(AuditRedactionError);
    const ring: unknown[] = [];
    ring.push(ring);
    expect(() => redactAuditDetails({ ring }, none)).toThrow(expect.objectContaining({ name: 'AuditRedactionError', reason: 'cycle' }));
    const shared = { token: 't', keep: 1 };
    expect(redactAuditDetails({ x: shared, y: [shared] }, none)).toEqual({ x: { token: REDACTED, keep: 1 }, y: [{ token: REDACTED, keep: 1 }] });
  });

  it('AUD-4 a __proto__ key is kept as an own key and walked', () => {
    const input = JSON.parse('{"__proto__":{"x":"Bearer a"},"k":1}') as Record<string, unknown>;
    const out = redactAuditDetails(input, none);
    expect(Object.keys(out)).toEqual(['__proto__', 'k']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"x":"[redacted]"},"k":1}');
  });
});
