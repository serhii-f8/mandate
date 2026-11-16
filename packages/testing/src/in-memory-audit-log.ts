import type { AuditEventInput, AuditLog } from '@aiops/core';

/** Audit log fake for unit tests. Set `failNext` to make the next append reject. */
export class InMemoryAuditLog implements AuditLog {
  readonly events: AuditEventInput[] = [];
  failNext: Error | undefined;

  append(event: AuditEventInput): Promise<void> {
    const failure = this.failNext;
    if (failure !== undefined) {
      this.failNext = undefined;
      return Promise.reject(failure);
    }
    this.events.push(event);
    return Promise.resolve();
  }
}
