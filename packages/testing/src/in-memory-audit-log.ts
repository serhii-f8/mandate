import { redactAuditDetails, type AuditEventInput, type AuditLog } from '@aiops/core';

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Audit log fake for unit tests. Set `failNext` to make the next append reject. Redacts like
 * `DrizzleAuditLog` (AUD-4): `events` holds the redacted events, and details that cannot be
 * redacted reject with `AuditRedactionError` and record nothing.
 */
export class InMemoryAuditLog implements AuditLog {
  readonly events: AuditEventInput[] = [];
  failNext: Error | undefined;

  constructor(private readonly options: { readonly sensitiveKeys?: () => ReadonlySet<string> } = {}) {}

  append(event: AuditEventInput): Promise<void> {
    const failure = this.failNext;
    if (failure !== undefined) {
      this.failNext = undefined;
      return Promise.reject(failure);
    }
    let details: Record<string, unknown>;
    try {
      details = redactAuditDetails(event.details, this.options.sensitiveKeys?.() ?? NO_KEYS);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('audit redaction failed'));
    }
    this.events.push({ ...event, details });
    return Promise.resolve();
  }
}
