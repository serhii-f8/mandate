// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { parseVersionedKeys, type VersionedKeys } from '@aiops/core';

/**
 * Master keys for envelope encryption of credentials (SEC-2). The interface leaves room
 * for a KMS-backed provider; the shipped one reads `AIOPS_MASTER_KEYS`.
 */
export type KeyProvider = VersionedKeys;

/**
 * Parses `<version>:<base64 of 32 bytes>[,<version>:<base64>...]`. Errors name the
 * 1-based entry index and the problem, never the value.
 */
export function parseMasterKeys(value: string): KeyProvider {
  return parseVersionedKeys(value, 'AIOPS_MASTER_KEYS');
}
