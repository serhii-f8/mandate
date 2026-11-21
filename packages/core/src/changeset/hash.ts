// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { createHash, type Hash } from 'node:crypto';
import { canonicalJson, compareTargetIds } from './canonical.js';

export interface HashableItem {
  targetId: string;
  status: string;
  reason?: string;
  before: unknown;
  after: unknown;
}

const FORMAT = 'aiops.changeset.v1';

/** Incremental change-set hash over operation, arguments and items in target order (CS-4). */
export class ChangeSetHasher {
  private readonly hash: Hash = createHash('sha256');
  private last: string | undefined;

  constructor(operation: string, normalizedArgs: unknown) {
    this.hash.update(`${canonicalJson({ format: FORMAT, operation, args: normalizedArgs })}\n`);
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
