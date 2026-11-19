import { describe, expect, it } from 'vitest';
import { InMemoryAuditLog } from './in-memory-audit-log.js';
import { describeConfigRevisionStoreContract } from './config-revision-store-contract.js';
import { InMemoryConfigRevisionStore } from './in-memory-config-revision-store.js';

describeConfigRevisionStoreContract(() => {
  const audit = new InMemoryAuditLog();
  return Promise.resolve({ store: new InMemoryConfigRevisionStore(audit), auditRows: () => Promise.resolve([...audit.events]) });
});

describe('CFG-4 in-memory configuration revision store', () => {
  it('CFG-4 a failing audit append refuses the apply and writes no revision', async () => {
    const audit = new InMemoryAuditLog();
    const store = new InMemoryConfigRevisionStore(audit);
    audit.failNext = new Error('audit down');
    await expect(
      store.apply(
        { id: '00000000-0000-4000-8000-000000000001', hash: 'a'.repeat(64), files: {}, actor: 'cli', summary: { connections: 0, operations: 0, roles: 0, notifications: 0 } },
        { id: '00000000-0000-4000-8000-000000000002', actor: 'cli', action: 'config.apply', outcome: 'ok', correlationId: '00000000-0000-4000-8000-000000000003', details: {} },
        null,
      ),
    ).rejects.toThrow('audit down');
    expect(await store.active()).toBeUndefined();
  });

  it('CFG-3 emitReconnect calls onReconnect, and a closed listener hears nothing', async () => {
    const store = new InMemoryConfigRevisionStore(new InMemoryAuditLog());
    let reconnects = 0;
    let changes = 0;
    const listener = await store.listen({ onChange: () => { changes += 1; }, onReconnect: () => { reconnects += 1; }, onError: () => undefined });
    store.emitReconnect();
    expect(reconnects).toBe(1);
    await listener.close();
    store.emitReconnect();
    await store.apply(
      { id: '00000000-0000-4000-8000-000000000001', hash: 'a'.repeat(64), files: {}, actor: 'cli', summary: { connections: 0, operations: 0, roles: 0, notifications: 0 } },
      { id: '00000000-0000-4000-8000-000000000002', actor: 'cli', action: 'config.apply', outcome: 'ok', correlationId: '00000000-0000-4000-8000-000000000003', details: {} },
      null,
    );
    expect(reconnects).toBe(1);
    expect(changes).toBe(0);
  });
});
