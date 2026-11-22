// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * Versioned symmetric keys from an environment variable: credential master keys (SEC-2) and
 * Temporal payload keys (SEC-4) share the format and the parser.
 */
export interface VersionedKeys {
  /** The key new data is encrypted under: the highest configured version. */
  current(): { version: number; key: Buffer };
  get(version: number): Buffer | undefined;
}

const KEY_BYTES = 32;
const VERSION_PATTERN = /^[1-9][0-9]{0,8}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Parses `<version>:<base64 of 32 bytes>[,<version>:<base64>...]` read from `variable`.
 * Errors name the variable, the 1-based entry index and the problem, never the value (SEC-3).
 */
export function parseVersionedKeys(value: string, variable: string): VersionedKeys {
  const fail = (reason: string): never => {
    throw new Error(`${variable}: ${reason}`);
  };
  if (value.trim() === '') fail('no keys configured');

  const keys = new Map<number, Buffer>();
  value
    .split(',')
    .map((entry) => entry.trim())
    .forEach((entry, index) => {
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
  if (currentKey === undefined) return fail('no keys configured');
  return {
    current: () => ({ version: currentVersion, key: currentKey }),
    get: (version) => keys.get(version),
  };
}
