import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { AuditLog, CredentialHandle, CredentialStatus, CredentialVault } from '@aiops/core';
import type { Db } from './client.js';
import { openSealed, rewrap, seal, type SealedCredential } from './envelope.js';
import type { KeyProvider } from './keyring.js';
import { credential } from './schema.js';

function parseSecret(plaintext: Buffer): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('credential value is malformed');
  }
  const secret: Record<string, string> = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error('credential value is malformed');
    secret[field] = value;
  }
  return Object.freeze(secret);
}

/**
 * PostgreSQL implementation of the core `CredentialVault` port (SEC-2). Rows hold only
 * envelope-encrypted values; plaintext exists only inside `open()` and its caller.
 */
export class PostgresCredentialVault implements CredentialVault {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
  ) {}

  async put(input: {
    ref: string;
    scheme: string;
    secret: Readonly<Record<string, string>>;
    actor: string;
  }): Promise<{ keyVersion: number }> {
    const plaintext = Buffer.from(JSON.stringify(input.secret), 'utf8');
    let record: SealedCredential;
    try {
      record = seal(this.keys, input.ref, input.scheme, plaintext);
    } finally {
      plaintext.fill(0);
    }
    const values = { ...record, updatedBy: input.actor, updatedAt: sql`now()` };
    await this.db
      .insert(credential)
      .values({ ref: input.ref, ...values })
      .onConflictDoUpdate({ target: credential.ref, set: values });
    return { keyVersion: record.keyVersion };
  }

  async describe(refs: readonly string[]): Promise<CredentialStatus[]> {
    if (refs.length === 0) return [];
    // Metadata columns only: ciphertext, nonces and wrapped keys are never selected.
    const rows = await this.db
      .select({
        ref: credential.ref,
        scheme: credential.scheme,
        updatedAt: credential.updatedAt,
        updatedBy: credential.updatedBy,
        keyVersion: credential.keyVersion,
      })
      .from(credential)
      .where(inArray(credential.ref, [...refs]));
    const byRef = new Map(rows.map((row) => [row.ref, row]));
    return refs.map((ref) => {
      const row = byRef.get(ref);
      return row === undefined ? { ref, set: false } : { ...row, set: true };
    });
  }

  async handle(ref: string): Promise<CredentialHandle | undefined> {
    const [row] = await this.db.select().from(credential).where(eq(credential.ref, ref));
    if (row === undefined) return undefined;
    const keys = this.keys;
    const record: SealedCredential = {
      scheme: row.scheme,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      wrappedKey: row.wrappedKey,
      keyNonce: row.keyNonce,
      keyVersion: row.keyVersion,
    };
    return {
      ref,
      scheme: row.scheme,
      open: () => {
        try {
          const plaintext = openSealed(keys, ref, record);
          try {
            return Promise.resolve(parseSecret(plaintext));
          } finally {
            plaintext.fill(0);
          }
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error('credential could not be opened'));
        }
      },
    };
  }

  /**
   * Re-wraps every data key that is not under the current master key version (the
   * ciphertext is untouched), one row per transaction, idempotent. Each re-wrapped row is
   * audited as `credential.rotate` inside its transaction: if the append fails the row
   * rolls back, stays on its old version and a re-run retries it. Rows whose key version
   * is not configured or that do not authenticate are left alone and listed by ref in
   * `failed`. `onOldVersions` counts every row still not on the current version.
   */
  async rotate(
    actor: string,
    audit: AuditLog,
    correlationId: string,
  ): Promise<{ rewrapped: number; onOldVersions: number; failed: readonly string[] }> {
    const toVersion = this.keys.current().version;
    const candidates = await this.db
      .select({ ref: credential.ref })
      .from(credential)
      .where(ne(credential.keyVersion, toVersion))
      .orderBy(asc(credential.ref));

    let rewrapped = 0;
    const failed: string[] = [];
    for (const { ref } of candidates) {
      let outcome: 'rewrapped' | 'skipped' | 'unreadable';
      try {
        outcome = await this.db.transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(credential)
            .where(and(eq(credential.ref, ref), ne(credential.keyVersion, toVersion)))
            .for('update');
          // Gone, rewritten or rotated by a concurrent run since the candidate scan.
          if (row === undefined) return 'skipped';
          let next: SealedCredential;
          try {
            next = rewrap(this.keys, ref, row);
          } catch {
            return 'unreadable';
          }
          await tx
            .update(credential)
            .set({ wrappedKey: next.wrappedKey, keyNonce: next.keyNonce, keyVersion: next.keyVersion })
            .where(eq(credential.ref, ref));
          // Throws to roll the row back when the audit cannot be written (AUD-1).
          await audit.append({
            id: randomUUID(),
            actor,
            action: 'credential.rotate',
            subject: ref,
            outcome: 'ok',
            correlationId,
            details: { fromVersion: row.keyVersion, toVersion },
          });
          return 'rewrapped';
        });
      } catch {
        // Rolled back (audit or database failure); the row stays on its old version and
        // is counted in `onOldVersions`, so a re-run retries it.
        outcome = 'skipped';
      }
      if (outcome === 'rewrapped') rewrapped += 1;
      if (outcome === 'unreadable') failed.push(ref);
    }

    const [remaining] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(credential)
      .where(ne(credential.keyVersion, toVersion));
    return { rewrapped, onOldVersions: remaining?.n ?? 0, failed };
  }
}
