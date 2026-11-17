import type { AuditEventInput } from './audit.js';

/** Port for credentials held encrypted at rest (SEC-2). Implemented in `@aiops/db`. */
export interface CredentialHandle {
  readonly ref: string;
  /** Credential scheme name, e.g. `bearer`. */
  readonly scheme: string;
  /** Decrypts the secret fields. Callers must not log or return them (SEC-3). */
  open(): Promise<Readonly<Record<string, string>>>;
}

export interface CredentialStatus {
  readonly ref: string;
  readonly set: boolean;
  readonly scheme?: string;
  readonly updatedAt?: Date;
  readonly updatedBy?: string;
  readonly keyVersion?: number;
}

export interface CredentialVault {
  put(input: {
    ref: string;
    scheme: string;
    secret: Readonly<Record<string, string>>;
    actor: string;
    /**
     * Audit of the change (AUD-1). The vault appends this event to the audit log itself,
     * in the same database transaction as the write: both are committed or neither is,
     * and if the append fails nothing is stored and `put` rejects.
     */
    audit?: { event: (keyVersion: number) => AuditEventInput };
  }): Promise<{ keyVersion: number }>;
  describe(refs: readonly string[]): Promise<CredentialStatus[]>;
  handle(ref: string): Promise<CredentialHandle | undefined>;
}
