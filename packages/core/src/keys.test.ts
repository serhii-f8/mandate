import { describe, expect, it } from 'vitest';
import { parseVersionedKeys } from './keys.js';

// Fixed, obviously fake 32-byte test keys (base64 of repeated bytes).
const KEY_1 = Buffer.alloc(32, 1).toString('base64');
const KEY_2 = Buffer.alloc(32, 2).toString('base64');

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('versioned keys', () => {
  it('SEC-2 SEC-4 parseVersionedKeys picks the highest version and names only the variable in errors', () => {
    const keys = parseVersionedKeys(` 2:${KEY_2} , 1:${KEY_1} `, 'SOME_KEYS');
    expect(keys.current().version).toBe(2);
    expect(keys.current().key.equals(Buffer.from(KEY_2, 'base64'))).toBe(true);
    expect(keys.get(1)?.equals(Buffer.from(KEY_1, 'base64'))).toBe(true);
    expect(keys.get(3)).toBeUndefined();

    for (const bad of ['', KEY_1, `0:${KEY_1}`, `1:${KEY_1},1:${KEY_2}`, `1:${KEY_1},2:short`]) {
      const message = messageOf(() => parseVersionedKeys(bad, 'SOME_KEYS'));
      expect(message).toMatch(/^SOME_KEYS: /);
      for (const secret of [KEY_1, KEY_2, 'short']) expect(message).not.toContain(secret);
    }
    expect(messageOf(() => parseVersionedKeys(`1:${KEY_1},2:short`, 'SOME_KEYS'))).toMatch(/^SOME_KEYS: entry 2 /);
  });
});
