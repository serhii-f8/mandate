// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyProvider } from './keyring.js';

/**
 * Envelope encryption for credentials (SEC-2, ADR 0019). A random 256-bit data key per
 * write encrypts the secret with AES-256-GCM (AAD bound to ref and scheme); the data key
 * is wrapped with AES-256-GCM under a master key (AAD bound to ref and key version).
 * Swapping ciphertexts between refs or schemes, or relabelling the key version, fails
 * authentication. The GCM tag is appended to `ciphertext` and to `wrappedKey`.
 */
export interface SealedCredential {
  readonly scheme: string;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly wrappedKey: Buffer;
  readonly keyNonce: Buffer;
  readonly keyVersion: number;
}

const ALGORITHM = 'aes-256-gcm';
const DATA_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const valueAad = (ref: string, scheme: string): Buffer => Buffer.from(`aiops:credential:v1:${ref}:${scheme}`, 'utf8');
const keyAad = (ref: string, keyVersion: number): Buffer =>
  Buffer.from(`aiops:dek:v1:${ref}:${String(keyVersion)}`, 'utf8');

function encrypt(key: Buffer, aad: Buffer, plaintext: Buffer): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext, nonce };
}

/** Decrypts or throws a fixed message; the crypto error is dropped so nothing leaks. */
function decrypt(key: Buffer, aad: Buffer, nonce: Buffer, sealed: Buffer, what: string): Buffer {
  // Intermediate plaintext copies, zeroed on success and on authentication failure.
  const parts: Buffer[] = [];
  try {
    if (nonce.length !== NONCE_BYTES || sealed.length < TAG_BYTES) throw new Error('malformed');
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    parts.push(decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)));
    parts.push(decipher.final());
    // The caller owns and zero-fills the returned buffer.
    return Buffer.concat(parts);
  } catch {
    throw new Error(`credential ${what} could not be decrypted`);
  } finally {
    for (const part of parts) part.fill(0);
  }
}

function masterKey(keys: KeyProvider, version: number): Buffer {
  const key = keys.get(version);
  if (key === undefined) throw new Error(`credential key version ${String(version)} is not available`);
  return key;
}

function unwrapDataKey(keys: KeyProvider, ref: string, record: SealedCredential): Buffer {
  return decrypt(
    masterKey(keys, record.keyVersion),
    keyAad(ref, record.keyVersion),
    record.keyNonce,
    record.wrappedKey,
    'data key',
  );
}

function wrapDataKey(keys: KeyProvider, ref: string, dataKey: Buffer): Pick<SealedCredential, 'wrappedKey' | 'keyNonce' | 'keyVersion'> {
  const { version, key } = keys.current();
  const { ciphertext, nonce } = encrypt(key, keyAad(ref, version), dataKey);
  return { wrappedKey: ciphertext, keyNonce: nonce, keyVersion: version };
}

export function seal(keys: KeyProvider, ref: string, scheme: string, plaintext: Buffer): SealedCredential {
  const dataKey = randomBytes(DATA_KEY_BYTES);
  try {
    const { ciphertext, nonce } = encrypt(dataKey, valueAad(ref, scheme), plaintext);
    return { scheme, ciphertext, nonce, ...wrapDataKey(keys, ref, dataKey) };
  } finally {
    dataKey.fill(0);
  }
}

/** Returns the plaintext. The caller owns the buffer and should zero-fill it after use. */
export function openSealed(keys: KeyProvider, ref: string, record: SealedCredential): Buffer {
  const dataKey = unwrapDataKey(keys, ref, record);
  try {
    return decrypt(dataKey, valueAad(ref, record.scheme), record.nonce, record.ciphertext, 'value');
  } finally {
    dataKey.fill(0);
  }
}

/** Re-wraps the data key under the current master key; the ciphertext is unchanged. */
export function rewrap(keys: KeyProvider, ref: string, record: SealedCredential): SealedCredential {
  const dataKey = unwrapDataKey(keys, ref, record);
  try {
    return { ...record, ...wrapDataKey(keys, ref, dataKey) };
  } finally {
    dataKey.fill(0);
  }
}
