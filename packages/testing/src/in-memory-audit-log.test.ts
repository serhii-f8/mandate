import { describe, expect, it } from 'vitest';
import type { AuditEventInput } from '@aiops/core';
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
