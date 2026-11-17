import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { parseVersionedKeys, type VersionedKeys } from '@aiops/core';
import type { Payload, PayloadCodec } from '@temporalio/common';
// CommonJS package: only the default export is visible from ESM (verified with node 22.20).
import proto from '@temporalio/proto';

/**
 * Encrypting payload codec (SEC-4). Each payload (metadata and data) is serialized and sealed
 * with AES-256-GCM under the highest configured key version; the result carries only
 * `encoding: binary/encrypted` and `encryption-key-id: <version>`, and its data is
 * IV(12) ‖ tag(16) ‖ ciphertext. Decoding refuses anything not encrypted this way, and every
 * error message is fixed: it never contains payload bytes or key material (SEC-3).
 */

export const ENCRYPTED_ENCODING = 'binary/encrypted';
export const KEY_ID_METADATA = 'encryption-key-id';

const ProtoPayload = proto.temporal.api.common.v1.Payload;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION_PATTERN = /^[1-9][0-9]{0,8}$/;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** Parses `AIOPS_TEMPORAL_KEYS` (same format as `AIOPS_MASTER_KEYS`). */
export function parseTemporalKeys(raw: string): VersionedKeys {
  return parseVersionedKeys(raw, 'AIOPS_TEMPORAL_KEYS');
}

function encryptOne(keys: VersionedKeys, payload: Payload): Payload {
  const { version, key } = keys.current();
  const plaintext = ProtoPayload.encode(payload).finish();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    metadata: {
      encoding: utf8.encode(ENCRYPTED_ENCODING),
      [KEY_ID_METADATA]: utf8.encode(String(version)),
    },
    data: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
  };
}

function decryptOne(keys: VersionedKeys, payload: Payload): Payload {
  const encoding = payload.metadata?.encoding;
  if (encoding == null || fromUtf8.decode(encoding) !== ENCRYPTED_ENCODING) {
    throw new Error('payload is not encrypted');
  }
  const keyId = payload.metadata?.[KEY_ID_METADATA];
  const versionText = keyId == null ? '' : fromUtf8.decode(keyId);
  const key = VERSION_PATTERN.test(versionText) ? keys.get(Number(versionText)) : undefined;
  if (key === undefined) throw new Error('payload cannot be decrypted: unknown key version');

  const data = Buffer.from(payload.data ?? new Uint8Array());
  if (data.length < IV_BYTES + TAG_BYTES) throw new Error('payload cannot be decrypted');
  try {
    const decipher = createDecipheriv(ALGORITHM, key, data.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plaintext = Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    return ProtoPayload.decode(plaintext);
  } catch {
    // Authentication failure or a corrupt inner payload; the cause may quote bytes, so it is dropped.
    throw new Error('payload cannot be decrypted');
  }
}

export function createPayloadCodec(keys: VersionedKeys): PayloadCodec {
  return {
    encode: (payloads) => Promise.resolve(payloads.map((payload) => encryptOne(keys, payload))),
    // Synchronous throws inside the mapper surface as a rejected promise.
    decode: (payloads) => Promise.resolve().then(() => payloads.map((payload) => decryptOne(keys, payload))),
  };
}
