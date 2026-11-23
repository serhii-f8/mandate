// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { createHash, type Hash } from 'node:crypto';
import type { ManifestAction } from '../policy-model.js';
import { canonicalJson, compareTargetIds } from './canonical.js';

export interface HashableItem {
  targetId: string;
  status: string;
  reason?: string;
  before: unknown;
  after: unknown;
}

/**
 * The format a change-set hash was sealed with (CS-4, ADR 0069). 1: header without an action, the
 * format of every change-set prepared before 1.2.0. 2: the header also binds the manifest action.
 * 3: the header of version 2 under its own format name; used only for a change-set with files
 * (CS-10), whose arguments hold their descriptors. An older release does not know it and fails closed.
 */
export type HashVersion = 1 | 2 | 3;

/** The version every new preparation seals with. */
export const CURRENT_HASH_VERSION: HashVersion = 2;

/** The version a change-set with files is sealed with (CS-4, CS-10); every other keeps the current version. */
export const FILES_HASH_VERSION: HashVersion = 3;

/** What a change-set was sealed with: its hash version and, for a diff change-set, its manifest action. */
export interface HashSeal {
  readonly version: HashVersion;
  readonly action?: ManifestAction;
}

/**
 * A stored hash version this release does not know (a newer release wrote it, or the row is
 * corrupt). Every comparison with a stored hash treats it as a mismatch: fail closed (CS-4).
 */
export class UnknownHashVersionError extends Error {
  constructor(readonly version: unknown) {
    super('change-set hash version is unknown');
    this.name = 'UnknownHashVersionError';
  }
}

/** Whether this release can compute a hash of version `v`. */
export function isKnownHashVersion(v: unknown): v is HashVersion {
  return v === 1 || v === 2 || v === 3;
}

function header(operation: string, normalizedArgs: unknown, seal: HashSeal | undefined): string {
  const version: unknown = seal?.version ?? 1;
  if (version === 1) return canonicalJson({ format: 'mandate.changeset.v1', operation, args: normalizedArgs });
  if (version === 2 || version === 3) {
    // `null` for an opaque change-set, which has no manifest and so no action.
    const format = version === 2 ? 'mandate.changeset.v2' : 'mandate.changeset.v3';
    return canonicalJson({ format, operation, action: seal?.action ?? null, args: normalizedArgs });
  }
  throw new UnknownHashVersionError(version);
}

/** Incremental change-set hash over operation, arguments and items in target order (CS-4). */
export class ChangeSetHasher {
  private readonly hash: Hash = createHash('sha256');
  private last: string | undefined;

  /** Without `seal`, or with version 1, the version 1 bytes; a version outside 1 to 3 throws `UnknownHashVersionError`. */
  constructor(operation: string, normalizedArgs: unknown, seal?: HashSeal) {
    this.hash.update(`${header(operation, normalizedArgs, seal)}\n`);
  }

  add(item: HashableItem): void {
    if (this.last !== undefined && compareTargetIds(this.last, item.targetId) >= 0) {
      throw new Error('ChangeSetHasher: items must be added in strictly ascending target order');
    }
    this.last = item.targetId;
    const line = {
      target: item.targetId,
      status: item.status,
      before: item.before,
      after: item.after,
      ...(item.reason !== undefined ? { reason: item.reason } : {}),
    };
    this.hash.update(`${canonicalJson(line)}\n`);
  }

  digest(): string {
    return `sha256:${this.hash.digest('hex')}`;
  }
}
