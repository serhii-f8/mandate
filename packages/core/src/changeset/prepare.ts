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
  | {
      readonly ok: false;
      readonly changesetId?: string;
      readonly code: PrepareFailure;
      /** The upstream HTTP status of a failed read, when there was one (never upstream text, SEC-3). */
      readonly status?: number;
    };

const HASH_PAGE = 500;
const FIRST_ITEMS = 20;
const HOUR_MS = 3_600_000;

/** A fixed-code preparation failure that marks the change-set `failed`. */
class Failure extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
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
  if (!page.ok) throw new Failure(page.code, page.status);
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
  // normalizeArgs turned a present ids argument into a string array; an empty one names no targets (no selector fallback).
  const explicitIds = Array.isArray(rawIds) ? (rawIds as string[]) : undefined;
  if (explicitIds?.length === 0) return { ok: false, code: 'targets_missing' };
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
    // Required fields are checked on every record (CS-3), so they are read even when the call does not touch them.
    ...new Set([
      manifest.idField,
      ...Object.values(manifest.scopeArgs),
      ...touchedFields(manifest, args),
      ...manifest.requiredFields,
    ]),
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

  let changeset: ChangeSetRecord | undefined;
  try {
    if (explicitIds !== undefined) {
      if (explicitIds.length > manifest.maxTargets) throw new Failure('too_many_targets');
      for (const chunk of chunks(explicitIds, manifest.batchSize)) await processChunk(chunk);
    } else if (manifest.selector !== undefined) {
      const selector = manifest.selector;
      const selectorArgs = resolveTemplates(selector.args, args);
      const selectorFieldsArg = req.readFieldsArg(selector.operation);
      // Unique selector ids the store accepted: duplicates across pages do not count towards the total.
      let unique = 0;
      for (let pageNo = 1; ; pageNo++) {
        const page = okPage(
          await reader.read(selector.operation, {
            ...selectorArgs,
            [selector.pageArg]: pageNo,
            [selector.pageSizeArg]: selector.pageSize,
            ...(selectorFieldsArg === undefined ? {} : { [selectorFieldsArg]: [manifest.idField] }),
          }),
        );
        const ids = [
          ...new Set(
            page.items.map((r) => {
              const v = r[manifest.idField];
              // A row we cannot identify would silently shorten the target list.
              if (typeof v !== 'string' && typeof v !== 'number') throw new Failure('incomplete_read');
              return String(v);
            }),
          ),
        ];
        let inserted = 0;
        for (const chunk of chunks(ids, manifest.batchSize)) inserted += await processChunk(chunk);
        unique += inserted;
        const lastPage = page.items.length < selector.pageSize || inserted === 0;
        if (page.total === undefined) {
          if (lastPage) break;
          continue;
        }
        if (unique >= page.total) break;
        // The list ended (short, empty or nothing new) before the reported total: never a silently short set.
        if (lastPage) throw new Failure('incomplete_read');
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
    changeset = await repository.completePreparation(
      id,
      { status: 'prepared', hash: hasher.digest(), stats, preparedAt: deps.now() },
      event('preparing', 'prepared', { included: stats.included, excluded }),
    );
  } catch (err) {
    if (err instanceof LostRace) return { ok: false, changesetId: id, code: 'cancelled' };
    // Design §4.1: any failure after creation marks the change-set failed with a fixed code.
    const code = err instanceof Failure ? err.code : 'internal';
    let failed: ChangeSetRecord | undefined;
    try {
      failed = await repository.completePreparation(
        id,
        { status: 'failed', errorCode: code },
        event('preparing', 'failed', { errorCode: code }),
      );
    } catch {
      // Marking is best effort; the original error is the one worth reporting.
      throw err;
    }
    if (failed === undefined) return { ok: false, changesetId: id, code: 'cancelled' };
    const status = err instanceof Failure ? err.status : undefined;
    return { ok: false, changesetId: id, code, ...(status === undefined ? {} : { status }) };
  }
  if (changeset === undefined) return { ok: false, changesetId: id, code: 'cancelled' };
  // Outside the try: once prepared, the change-set must not be marked failed by a later read error.
  const firstItems = await repository.itemsPage(id, { limit: FIRST_ITEMS });
  return { ok: true, changeset, firstItems };
}
