/**
 * Master keys for envelope encryption of credentials (SEC-2). The interface leaves room
 * for a KMS-backed provider; the shipped one reads `AIOPS_MASTER_KEYS`.
 */
export interface KeyProvider {
  /** The key new data keys are wrapped under: the highest configured version. */
  current(): { version: number; key: Buffer };
  get(version: number): Buffer | undefined;
}

const KEY_BYTES = 32;
const VERSION_PATTERN = /^[1-9][0-9]{0,8}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function fail(reason: string): never {
  // Never include the configured value: it is key material (SEC-3).
  throw new Error(`AIOPS_MASTER_KEYS: ${reason}`);
}

/**
 * Parses `<version>:<base64 of 32 bytes>[,<version>:<base64>...]`. Errors name the
 * 1-based entry index and the problem, never the value.
 */
export function parseMasterKeys(value: string): KeyProvider {
  const entries = value.split(',').map((entry) => entry.trim());
  if (value.trim() === '') fail('no keys configured');

  const keys = new Map<number, Buffer>();
  entries.forEach((entry, index) => {
    const position = `entry ${String(index + 1)}`;
    const separator = entry.indexOf(':');
    if (separator < 0) fail(`${position} is not of the form <version>:<base64 key>`);
    const versionText = entry.slice(0, separator).trim();
    const keyText = entry.slice(separator + 1).trim();
    if (!VERSION_PATTERN.test(versionText)) fail(`${position} has a version that is not a positive integer`);
    const version = Number(versionText);
    if (keys.has(version)) fail(`${position} repeats a key version`);
    if (!BASE64_PATTERN.test(keyText)) fail(`${position} is not valid base64`);
    const key = Buffer.from(keyText, 'base64');
    if (key.length !== KEY_BYTES || key.toString('base64') !== keyText) {
      fail(`${position} must be exactly ${String(KEY_BYTES)} bytes, base64-encoded`);
    }
    keys.set(version, key);
  });

  const currentVersion = Math.max(...keys.keys());
  const currentKey = keys.get(currentVersion);
  // Unreachable: the value is non-empty, so every entry was validated into `keys`.
  if (currentKey === undefined) fail('no keys configured');
  return {
    current: () => ({ version: currentVersion, key: currentKey }),
    get: (version) => keys.get(version),
  };
}
