// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { AuditRedactionError, type AuditEventInput } from '@mandate/core';
import { InMemoryAuditLog } from './in-memory-audit-log.js';

const event: AuditEventInput = {
  id: 'e1',
  actor: 'anonymous',
  action: 'tool.call',
  outcome: 'ok',
  correlationId: 'c1',
  details: {},
};

describe('InMemoryAuditLog', () => {
  it('records appended events in order', async () => {
    const log = new InMemoryAuditLog();
    await log.append(event);
    await log.append({ ...event, id: 'e2' });
    expect(log.events.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('rejects once with failNext and records nothing for that call', async () => {
    const log = new InMemoryAuditLog();
    log.failNext = new Error('database down');
    await expect(log.append(event)).rejects.toThrow('database down');
    await log.append(event);
    expect(log.events).toHaveLength(1);
  });
});

describe('AUD-4 InMemoryAuditLog redaction', () => {
  it('AUD-4 the fake redacts like the real log', async () => {
    const log = new InMemoryAuditLog({ sensitiveKeys: () => new Set(['cost']) });
    await log.append({ ...event, details: { token: 't', nested: { cost: 5 }, auth: 'Bearer x', count: 2 } });
    expect(log.events.map((e) => e.details)).toEqual([{ token: '[redacted]', nested: { cost: '[redacted]' }, auth: '[redacted]', count: 2 }]);
  });

  it('AUD-4 the fake applies the key pattern without configured keys', async () => {
    const log = new InMemoryAuditLog();
    await log.append({ ...event, details: { password: 'p', cost: 5 } });
    expect(log.events[0]?.details).toEqual({ password: '[redacted]', cost: 5 });
  });

  it('AUD-4 the fake fails closed on details that cannot be redacted', async () => {
    const log = new InMemoryAuditLog();
    const details: Record<string, unknown> = {};
    details.self = details;
    await expect(log.append({ ...event, details })).rejects.toBeInstanceOf(AuditRedactionError);
    expect(log.events).toHaveLength(0);
  });
});
