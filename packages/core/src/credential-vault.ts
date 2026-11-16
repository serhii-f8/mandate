/** Port for credentials held encrypted at rest (SEC-2). Implemented in `@aiops/db`. */
export interface CredentialHandle {
  readonly ref: string;
  /** Credential scheme name, e.g. `bearer`. */
  readonly scheme: string;
  /** Decrypts the secret fields. Callers must not log or return them (SEC-3). */
  open(): Promise<Readonly<Record<string, string>>>;
}

export interface CredentialStatus {
  ref: string;
  set: boolean;
  scheme?: string;
  updatedAt?: Date;
  updatedBy?: string;
  keyVersion?: number;
}

export interface CredentialVault {
  put(input: {
    ref: string;
    scheme: string;
    secret: Readonly<Record<string, string>>;
    actor: string;
  }): Promise<{ keyVersion: number }>;
  describe(refs: readonly string[]): Promise<CredentialStatus[]>;
  handle(ref: string): Promise<CredentialHandle | undefined>;
}
