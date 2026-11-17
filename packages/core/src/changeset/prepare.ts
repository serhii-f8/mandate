import type { Caller } from '../caller.js';
import type { ManifestDefinition, ManifestTemplate, OperationDefinition } from '../policy-model.js';
import { changesetTransitionEvent } from './audit.js';
import { normalizeArgs } from './canonical.js';
import { ChangeSetHasher } from './hash.js';
import { buildItems, touchedFields } from './items.js';
import type { ChangeItemRecord, ChangeSetRecord, ChangeSetStatus } from './model.js';
import type { ChangeSetRepository, PrepareFailure, ReadPage, UpstreamReader } from './ports.js';

export type { PrepareFailure } from './ports.js';

export interface PrepareDeps {
  readonly repository: ChangeSetRepository;
  readonly reader: UpstreamReader;
  readonly newId: () => string;
  readonly now: () => Date;
}

export interface PrepareRequest {
  readonly operation: OperationDefinition & { readonly manifest: ManifestDefinition };
  /** Arguments already validated against the operation's input schema (MCP-3). */
  readonly args: Readonly<Record<string, unknown>>;
  readonly caller: Caller;
  readonly correlationId: string;
  readonly configHash: string;
  readonly expireAfterHours: number;
  /** The `fields_arg` of a read operation, or undefined when it has none. */
  readonly readFieldsArg: (readOperationId: string) => string | undefined;
}

export type PrepareOutcome =
  | { readonly ok: true; readonly changeset: ChangeSetRecord; readonly firstItems: readonly ChangeItemRecord[] }
  | { readonly ok: false; readonly changesetId?: string; readonly code: PrepareFailure };

const HASH_PAGE = 500;
const FIRST_ITEMS = 20;
const HOUR_MS = 3_600_000;

/** A fixed-code preparation failure that marks the change-set `failed`. */
class Failure extends Error {
  constructor(readonly code: string) {
    super(`preparation failed: ${code}`);
  }
}

/** Raised when the change-set left `preparing` under us (cancelled or expired). */
class LostRace extends Error {
  constructor() {
    super('change-set left preparing');
  }
}

function resolveTemplates(
  templates: Readonly<Record<string, ManifestTemplate>>,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, t] of Object.entries(templates)) {
    const value = typeof t === 'object' ? (args[t.arg] ?? t.default) : t;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function okPage(page: ReadPage): Extract<ReadPage, { ok: true }> {
  if (!page.ok) throw new Failure(page.code);
  if (page.truncated) throw new Failure('incomplete_read');
  return page;
}

/**
 * Prepares a change-set from the operation's manifest (design §4.1): resolves targets,
 * reads current state in chunks, stores one item per target, then hashes the stored items
 * page by page. Nothing is written upstream (CS-1); memory holds at most one selector page
 * and one read chunk (NFR-7).
 */
export async function prepareChangeSet(deps: PrepareDeps, req: PrepareRequest): Promise<PrepareOutcome> {
  const { repository, reader } = deps;
  const { operation, caller, correlationId } = req;
  const manifest = operation.manifest;
  const args = normalizeArgs(req.args, manifest.idsArg);
  const rawIds = manifest.idsArg === undefined ? undefined : args[manifest.idsArg];
  const explicitIds = Array.isArray(rawIds) && rawIds.length > 0 ? (rawIds as string[]) : undefined;
  if (explicitIds === undefined && manifest.selector === undefined) return { ok: false, code: 'targets_missing' };

  const id = deps.newId();
  const ref = { id, operation: operation.id };
  const event = (from: ChangeSetStatus | null, to: ChangeSetStatus, details?: Record<string, string | number>) =>
    changesetTransitionEvent({
      id: deps.newId(),
      actor: caller.subject,
      ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
      changeset: ref,
      from,
      to,
      correlationId,
      ...(details === undefined ? {} : { details }),
    });

  const createdAt = deps.now();
  await repository.create(
    {
      id,
      operation: operation.id,
      connection: operation.connection,
      requester: caller.subject,
      ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
      args,
      configHash: req.configHash,
      correlationId,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + req.expireAfterHours * HOUR_MS),
    },
    event(null, 'preparing'),
  );

  const readFieldsArg = req.readFieldsArg(manifest.readBefore.operation);
  const readFields = [
    ...new Set([manifest.idField, ...Object.values(manifest.scopeArgs), ...touchedFields(manifest, args)]),
  ];
  const readArgs = resolveTemplates(manifest.readBefore.args, args);
  let stored = 0;

  /** Reads, builds and stores one chunk; returns how many new items the store accepted. */
  const processChunk = async (targetIds: readonly string[]): Promise<number> => {
    const page = okPage(
      await reader.read(manifest.readBefore.operation, {
        ...readArgs,
        [manifest.readBefore.idsArg]: targetIds,
        ...(readFieldsArg === undefined ? {} : { [readFieldsArg]: readFields }),
      }),
    );
    const items = buildItems({ manifest, args, targetIds, records: page.items });
    let inserted: number;
    try {
      inserted = await repository.appendItems(id, items);
    } catch (err) {
      const current = await repository.get(id);
      if (current !== undefined && current.status !== 'preparing') throw new LostRace();
      throw err;
    }
    stored += inserted;
    if (stored > manifest.maxTargets) throw new Failure('too_many_targets');
    return inserted;
  };

  try {
    if (explicitIds !== undefined) {
      if (explicitIds.length > manifest.maxTargets) throw new Failure('too_many_targets');
      for (const chunk of chunks(explicitIds, manifest.batchSize)) await processChunk(chunk);
    } else if (manifest.selector !== undefined) {
      const selector = manifest.selector;
      const selectorArgs = resolveTemplates(selector.args, args);
      const selectorFieldsArg = req.readFieldsArg(selector.operation);
      let seen = 0;
      for (let pageNo = 1; ; pageNo++) {
        const page = okPage(
          await reader.read(selector.operation, {
            ...selectorArgs,
            [selector.pageArg]: pageNo,
            [selector.pageSizeArg]: selector.pageSize,
            ...(selectorFieldsArg === undefined ? {} : { [selectorFieldsArg]: [manifest.idField] }),
          }),
        );
        if (page.items.length === 0) break;
        const ids = [
          ...new Set(
            page.items.flatMap((r) => {
              const v = r[manifest.idField];
              return typeof v === 'string' || typeof v === 'number' ? [String(v)] : [];
            }),
          ),
        ];
        let inserted = 0;
        for (const chunk of chunks(ids, manifest.batchSize)) inserted += await processChunk(chunk);
        seen += page.items.length;
        if (inserted === 0) break;
        if (page.items.length < selector.pageSize) break;
        if (page.total !== undefined && seen >= page.total) break;
      }
      if (stored === 0) throw new Failure('targets_missing');
    }

    const stats = await repository.stats(id);
    const hasher = new ChangeSetHasher(operation.id, args);
    let after: string | undefined;
    for (;;) {
      const page = await repository.itemsPage(id, { limit: HASH_PAGE, ...(after === undefined ? {} : { after }) });
      for (const item of page) hasher.add(item);
      const last = page.at(-1);
      if (last === undefined || page.length < HASH_PAGE) break;
      after = last.targetId;
    }
    const excluded = Object.values(stats.excluded).reduce((sum, n) => sum + n, 0);
    const changeset = await repository.completePreparation(
      id,
      { status: 'prepared', hash: hasher.digest(), stats, preparedAt: deps.now() },
      event('preparing', 'prepared', { included: stats.included, excluded }),
    );
    if (changeset === undefined) return { ok: false, changesetId: id, code: 'cancelled' };
    const firstItems = await repository.itemsPage(id, { limit: FIRST_ITEMS });
    return { ok: true, changeset, firstItems };
  } catch (err) {
    if (err instanceof LostRace) return { ok: false, changesetId: id, code: 'cancelled' };
    if (!(err instanceof Failure)) throw err;
    const failed = await repository.completePreparation(
      id,
      { status: 'failed', errorCode: err.code },
      event('preparing', 'failed', { errorCode: err.code }),
    );
    return { ok: false, changesetId: id, code: failed === undefined ? 'cancelled' : err.code };
  }
}
