import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openSealed, rewrap, seal, type SealedCredential } from './envelope.js';
import { parseMasterKeys } from './keyring.js';

const KEY_1 = randomBytes(32).toString('base64');
const KEY_2 = randomBytes(32).toString('base64');
const v1Only = parseMasterKeys(`1:${KEY_1}`);
const v1And2 = parseMasterKeys(`1:${KEY_1},2:${KEY_2}`);
const v2Only = parseMasterKeys(`2:${KEY_2}`);
const SECRET = Buffer.from(JSON.stringify({ token: 'dev-only-bearer-token' }), 'utf8');

function flipFirstByte(value: Buffer): Buffer {
  const copy = Buffer.from(value);
  copy[0] = (copy[0] ?? 0) ^ 0xff;
  return copy;
}

describe('SEC-2 envelope encryption', () => {
  it('round-trips a secret under the current master key', () => {
    const record = seal(v1Only, 'magento_token', 'bearer', SECRET);
    expect(record.keyVersion).toBe(1);
    expect(record.scheme).toBe('bearer');
    expect(record.nonce).toHaveLength(12);
    expect(record.keyNonce).toHaveLength(12);
    expect(record.ciphertext.includes(SECRET)).toBe(false);
    expect(openSealed(v1Only, 'magento_token', record).equals(SECRET)).toBe(true);
  });

  it('seals under the highest version when several keys are configured', () => {
    expect(seal(v1And2, 'r', 'bearer', SECRET).keyVersion).toBe(2);
  });

  it('two seals of the same value differ', () => {
    const a = seal(v1Only, 'r', 'bearer', SECRET);
    const b = seal(v1Only, 'r', 'bearer', SECRET);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedKey.equals(b.wrappedKey)).toBe(false);
    expect(a.nonce.equals(b.nonce)).toBe(false);
  });

  describe('rejects a record that does not authenticate', () => {
    const record = seal(v1Only, 'magento_token', 'bearer', SECRET);
    const cases: [string, string, SealedCredential][] = [
      ['tampered ciphertext', 'magento_token', { ...record, ciphertext: flipFirstByte(record.ciphertext) }],
      ['tampered wrapped key', 'magento_token', { ...record, wrappedKey: flipFirstByte(record.wrappedKey) }],
      ['wrong ref', 'other_token', record],
      ['wrong scheme', 'magento_token', { ...record, scheme: 'api_key' }],
      ['wrong key version', 'magento_token', { ...record, keyVersion: 2 }],
    ];
    it.each(cases)('%s', (_name, ref, tampered) => {
      expect(() => openSealed(v1And2, ref, tampered)).toThrow(/^credential /);
    });

    it('a key version the provider does not hold', () => {
      expect(() => openSealed(v2Only, 'magento_token', record)).toThrow(/key version 1 is not available/);
    });
  });

  it('rewrap under v2 keeps the plaintext and the ciphertext and changes key_version', () => {
    const record = seal(v1Only, 'r', 'bearer', SECRET);
    const rewrapped = rewrap(v1And2, 'r', record);
    expect(rewrapped.keyVersion).toBe(2);
    expect(rewrapped.ciphertext.equals(record.ciphertext)).toBe(true);
    expect(rewrapped.wrappedKey.equals(record.wrappedKey)).toBe(false);
    expect(openSealed(v2Only, 'r', rewrapped).equals(SECRET)).toBe(true);
  });

  describe('parseMasterKeys', () => {
    it('throws for a short key without the value in the message', () => {
      let message = '';
      try {
        parseMasterKeys('1:short');
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^AIOPS_MASTER_KEYS: entry 1 /);
      expect(message).not.toContain('short');
    });

    it.each([
      ['empty value', ''],
      ['no separator', KEY_1],
      ['version zero', `0:${KEY_1}`],
      ['non-integer version', `1.5:${KEY_1}`],
      ['duplicate version', `1:${KEY_1},1:${KEY_2}`],
      ['invalid base64', `1:${'!'.repeat(44)}`],
      ['33-byte key', `1:${randomBytes(33).toString('base64')}`],
    ])('rejects %s', (_name, value) => {
      expect(() => parseMasterKeys(value)).toThrow(/^AIOPS_MASTER_KEYS: /);
      try {
        parseMasterKeys(value);
      } catch (error) {
        for (const key of [KEY_1, KEY_2]) expect((error as Error).message).not.toContain(key);
      }
    });

    it('selects the highest version as current, regardless of order', () => {
      const keys = parseMasterKeys(` 2:${KEY_2} , 1:${KEY_1} `);
      expect(keys.current().version).toBe(2);
      expect(keys.get(1)?.equals(Buffer.from(KEY_1, 'base64'))).toBe(true);
      expect(keys.get(3)).toBeUndefined();
    });
  });
});
