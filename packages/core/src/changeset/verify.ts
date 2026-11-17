import { ChangeSetHasher } from './hash.js';
import type { ChangeSetRecord } from './model.js';
import type { ChangeSetRepository } from './ports.js';

const HASH_PAGE = 500;

/**
 * Recomputes a change-set hash from its stored items (CS-4). Items that are not excluded hash with
 * status `pending`, the status they had when the hash was taken, so the result is stable while
 * execution moves items to written or failed. Memory holds one page (NFR-7).
 */
export async function hashStoredItems(
  repository: Pick<ChangeSetRepository, 'itemsPage'>,
  changeset: Pick<ChangeSetRecord, 'id' | 'operation' | 'args'>,
): Promise<string> {
  const hasher = new ChangeSetHasher(changeset.operation, changeset.args);
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
