import type { AuditEventInput, AuditLog } from './audit.js';

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
     * Audit of the change (AUD-1), appended in the same transaction after the write:
     * if the append fails nothing is stored and `put` rejects.
     */
    audit?: { log: AuditLog; event: (keyVersion: number) => AuditEventInput };
  }): Promise<{ keyVersion: number }>;
  describe(refs: readonly string[]): Promise<CredentialStatus[]>;
  handle(ref: string): Promise<CredentialHandle | undefined>;
}
