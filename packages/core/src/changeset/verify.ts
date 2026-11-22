// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { ChangeSetHasher } from './hash.js';
import type { ChangeSetRecord } from './model.js';
import type { ChangeSetRepository } from './ports.js';

export { UnknownHashVersionError } from './hash.js';

const HASH_PAGE = 500;

/**
 * Recomputes a change-set hash from its stored items (CS-4). Items that are not excluded hash with
 * status `pending`, the status they had when the hash was taken, so the result is stable while
 * execution moves items to written or failed. Memory holds one page (NFR-7).
 *
 * The hash is taken with the change-set's stored version (absent: 1) and action, so a change-set
 * prepared before an upgrade keeps verifying (ADR 0069). A version outside 1 and 2 throws
 * `UnknownHashVersionError` before any item is read; callers comparing with a stored hash treat it
 * as a mismatch.
 */
export async function hashStoredItems(
  repository: Pick<ChangeSetRepository, 'itemsPage'>,
  changeset: Pick<ChangeSetRecord, 'id' | 'operation' | 'args' | 'hashVersion' | 'action'>,
): Promise<string> {
  const hasher = new ChangeSetHasher(changeset.operation, changeset.args, {
    version: changeset.hashVersion ?? 1,
    ...(changeset.action === undefined ? {} : { action: changeset.action }),
  });
  let after: string | undefined;
  for (;;) {
    const page = await repository.itemsPage(changeset.id, {
      limit: HASH_PAGE,
      ...(after === undefined ? {} : { after }),
    });
    for (const item of page) {
      hasher.add({ ...item, status: item.status === 'excluded' ? 'excluded' : 'pending' });
    }
    const last = page.at(-1);
    if (last === undefined || page.length < HASH_PAGE) break;
    after = last.targetId;
  }
  return hasher.digest();
}
