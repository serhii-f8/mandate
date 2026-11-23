// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { Caller } from '../caller.js';
import { resolveFileArgs, type FileRefusal } from '../files/file-args.js';
import { FileUnavailableError, type FileStore } from '../files/ports.js';
import type { FileLink } from '../files/model.js';
import type { ManifestDefinition, OperationDefinition } from '../policy-model.js';
import { changesetTransitionEvent } from './audit.js';
import { normalizeArgs, normalizeRecords } from './canonical.js';
import { checkRecordFields } from './checks.js';
import { PreparationFailure } from './failure.js';
import { callRecords, manifestAction } from './fields.js';
import { CURRENT_HASH_VERSION } from './hash.js';
import { buildItems, existenceReadIncomplete, touchedFields } from './items.js';
import type { ChangeItemRecord, ChangeSetRecord, ChangeSetStatus } from './model.js';
import { chunkLookups, chunks } from './lookups.js';
import { isOpaque } from './opaque.js';
import type { PreparationRepository, PrepareFailure, ReadPage, UpstreamReader } from './ports.js';
import { resolveTemplates } from './templates.js';
import { hashStoredItems } from './verify.js';

export type { PrepareFailure } from './ports.js';
export { resolveTemplates } from './templates.js';

export interface PrepareDeps {
  readonly repository: PreparationRepository;
  readonly reader: UpstreamReader;
  readonly newId: () => string;
  readonly now: () => Date;
  /** CS-10: where file arguments are looked up. Without it an operation with `files` is refused. */
  readonly files?: Pick<FileStore, 'get'>;
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

/**
 * Everything `createChangeSet` needs: a prepare request without the read-operation lookup, for any
 * operation. An opaque one needs no manifest; any other without a manifest is refused.
 */
export type CreateRequest = Omit<PrepareRequest, 'readFieldsArg' | 'operation'> & {
  readonly operation: OperationDefinition;
};

export interface RunPreparationRequest {
  readonly changesetId: string;
  readonly operation: OperationDefinition & { readonly manifest: ManifestDefinition };
  readonly readFieldsArg: (readOperationId: string) => string | undefined;
  readonly actor: string;
  readonly clientId?: string;
  readonly correlationId: string;
}

const FIRST_ITEMS = 20;
const HOUR_MS = 3_600_000;

/** Raised when the change-set left `preparing` under us (cancelled or expired). */
class LostRace extends Error {
  constructor() {
    super('change-set left preparing');
  }
}

function okPage(page: ReadPage): Extract<ReadPage, { ok: true }> {
  if (!page.ok) throw new PreparationFailure(page.code, page.status);
  if (page.truncated) throw new PreparationFailure('incomplete_read');
  return page;
}

/**
 * The normalized arguments of a manifest operation, or the refusal: no manifest means the operation
 * cannot prepare a change-set; no ids and no selector means no targets. With `recordsArg` the
 * records name the targets: none is `targets_missing`, two with one identifier `duplicate_targets`.
 */
function manifestArgs(
  manifest: ManifestDefinition | undefined,
  raw: Readonly<Record<string, unknown>>,
): Record<string, unknown> | 'operation_unavailable' | 'targets_missing' | 'duplicate_targets' {
  if (manifest === undefined) return 'operation_unavailable';
  if (manifest.recordsArg !== undefined) return normalizeRecords(raw, manifest.recordsArg, manifest.idField);
  const args = normalizeArgs(raw, manifest.idsArg);
  const rawIds = manifest.idsArg === undefined ? undefined : args[manifest.idsArg];
  // normalizeArgs turned a present ids argument into a string array; an empty one names no targets (no selector fallback).
  const explicitIds = Array.isArray(rawIds) ? (rawIds as string[]) : undefined;
  if (explicitIds?.length === 0) return 'targets_missing';
  if (explicitIds === undefined && manifest.selector === undefined) return 'targets_missing';
  return args;
}

/**
 * Creates the change-set row in `preparing` and audits `null -> preparing` (EXE-1). Reads nothing,
 * so it can run in the API call while `runPreparation` runs later, in a workflow activity.
 */
export async function createChangeSet(
  deps: Pick<PrepareDeps, 'repository' | 'newId' | 'now' | 'files'>,
  req: CreateRequest,
): Promise<
  | { ok: true; changeset: ChangeSetRecord }
  | { ok: false; code: PrepareFailure | FileRefusal; pointer?: string }
> {
  const { operation, caller, correlationId } = req;
  const normalized = isOpaque(operation) ? normalizeArgs(req.args, undefined) : manifestArgs(operation.manifest, req.args);
  if (typeof normalized === 'string') return { ok: false, code: normalized };

  // CS-10: each declared file ID becomes its descriptor, before anything is created (SEC-1: one code for
  // unknown, foreign and purged). Without a file store the operation fails closed.
  let args: Record<string, unknown> = normalized;
  let links: readonly FileLink[] = [];
  const declared = operation.files ?? [];
  if (declared.length > 0) {
    if (deps.files === undefined) return { ok: false, code: 'file_not_found', pointer: declared[0]?.pointer ?? '' };
    const resolved = await resolveFileArgs({ files: declared, args, owner: caller.subject, store: deps.files });
    if (!resolved.ok) return { ok: false, code: resolved.code, pointer: resolved.pointer };
    args = resolved.args;
    links = resolved.links;
  }

  const id = deps.newId();
  const createdAt = deps.now();
  let changeset: ChangeSetRecord;
  try {
    changeset = await deps.repository.create(
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
      expiresAt: new Date(createdAt.getTime() + Math.round(req.expireAfterHours * HOUR_MS)),
      ...(links.length === 0 ? {} : { files: links }),
    },
    changesetTransitionEvent({
      id: deps.newId(),
      actor: caller.subject,
      ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
      changeset: { id, operation: operation.id },
      from: null,
      to: 'preparing',
      correlationId,
    }),
  );
  } catch (err) {
    // Only the named error: a file that vanished between the lookup and the insert (CS-10).
    if (err instanceof FileUnavailableError) return { ok: false, code: 'file_not_found', pointer: err.pointer };
    throw err;
  }
  return { ok: true, changeset };
}

/** Creates the change-set, then prepares it in the same call (the pre-workflow path, CS-1). */
export async function prepareChangeSet(deps: PrepareDeps, req: PrepareRequest): Promise<PrepareOutcome> {
  const created = await createChangeSet(deps, req);
  if (!created.ok) return created;
  return runPreparation(deps, {
    changesetId: created.changeset.id,
    operation: req.operation,
    readFieldsArg: req.readFieldsArg,
    actor: req.caller.subject,
    ...(req.caller.clientId === undefined ? {} : { clientId: req.caller.clientId }),
    correlationId: req.correlationId,
  });
}

/**
 * Prepares a created change-set from the operation's manifest (design §4.1): reads current state in
 * chunks, stores one item per target, then hashes the stored items page by page. Safe to call again
 * after the change-set left `preparing` (NFR-2). Nothing is written upstream (CS-1); memory holds at
 * most one selector page and one read chunk (NFR-7).
 */
export async function runPreparation(deps: PrepareDeps, req: RunPreparationRequest): Promise<PrepareOutcome> {
  const { repository, reader } = deps;
  const { operation } = req;
  const manifest = operation.manifest;
  const id = req.changesetId;

  const current = await repository.get(id);
  if (current === undefined) return { ok: false, code: 'not_found' };
  if (current.status === 'prepared') {
    return { ok: true, changeset: current, firstItems: await repository.itemsPage(id, { limit: FIRST_ITEMS }) };
  }
  if (current.status === 'cancelled' || current.status === 'expired') {
    return { ok: false, changesetId: id, code: 'cancelled' };
  }
  if (current.status !== 'preparing') {
    return { ok: false, changesetId: id, code: current.errorCode ?? 'internal' };
  }

  const args = current.args;
  const records = callRecords(manifest, args);
  const rawIds = manifest.idsArg === undefined ? undefined : args[manifest.idsArg];
  // The records name the targets in normalized (target) order; otherwise the normalized ids argument.
  const explicitIds = records !== undefined ? [...records.keys()] : Array.isArray(rawIds) ? (rawIds as string[]) : undefined;
  const ref = { id, operation: operation.id };
  const event = (from: ChangeSetStatus | null, to: ChangeSetStatus, details?: Record<string, string | number>) =>
    changesetTransitionEvent({
      id: deps.newId(),
      actor: req.actor,
      ...(req.clientId === undefined ? {} : { clientId: req.clientId }),
      changeset: ref,
      from,
      to,
      correlationId: req.correlationId,
      ...(details === undefined ? {} : { details }),
    });

  // Items from an earlier attempt mean the reads cannot be replayed safely: fail fast.
  if ((await repository.stats(id)).total > 0) {
    const failed = await repository.completePreparation(
      id,
      { status: 'failed', errorCode: 'preparation_interrupted' },
      event('preparing', 'failed', { errorCode: 'preparation_interrupted' }),
    );
    if (failed === undefined) return { ok: false, changesetId: id, code: 'cancelled' };
    return { ok: false, changesetId: id, code: 'preparation_interrupted' };
  }

  const readFieldsArg = req.readFieldsArg(manifest.readBefore.operation);
  const readFields = [
    // Required fields are checked on every record (CS-3), so they are read even when the call does not touch them.
    // A delete stores every manifest field as its `before` (OPS-2); a create reads its records' fields.
    ...new Set([
      manifest.idField,
      ...Object.values(manifest.scopeArgs),
      ...(manifestAction(manifest) === 'delete' ? manifest.fields : touchedFields(manifest, args)),
      ...manifest.requiredFields,
      // The current-record fields the preparation checks and their lookup keys read (CS-3, OPS-7).
      ...checkRecordFields(manifest.checks ?? [], manifest.lookups),
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
    // CS-7: a create or delete must not mistake a target cut from a short page for an absent one.
    if (existenceReadIncomplete(manifest, page)) throw new PreparationFailure('incomplete_read');
    // OPS-7: the lookups of this chunk's items, read during preparation only and dropped after the checks.
    const lookups = await chunkLookups({ manifest, args, targetIds, records: page.items, reader, readFieldsArg: req.readFieldsArg });
    const items = buildItems({ manifest, args, targetIds, records: page.items, ...(lookups === undefined ? {} : { lookups }) });
    let inserted: number;
    try {
      inserted = await repository.appendItems(id, items);
    } catch (err) {
      const current = await repository.get(id);
      if (current !== undefined && current.status !== 'preparing') throw new LostRace();
      throw err;
    }
    stored += inserted;
    if (stored > manifest.maxTargets) throw new PreparationFailure('too_many_targets');
    return inserted;
  };

  let changeset: ChangeSetRecord | undefined;
  try {
    if (explicitIds !== undefined) {
      // createChangeSet refused a call without records; a stored one without any fails closed.
      if (records !== undefined && explicitIds.length === 0) throw new PreparationFailure('targets_missing');
      if (explicitIds.length > manifest.maxTargets) throw new PreparationFailure('too_many_targets');
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
              if (typeof v !== 'string' && typeof v !== 'number') throw new PreparationFailure('incomplete_read');
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
        if (lastPage) throw new PreparationFailure('incomplete_read');
      }
      if (stored === 0) throw new PreparationFailure('targets_missing');
    }

    const stats = await repository.stats(id);
    // CS-4: new preparations seal with the current version and the manifest's action (ADR 0069).
    const seal = { hashVersion: CURRENT_HASH_VERSION, action: manifestAction(manifest) } as const;
    const hash = await hashStoredItems(repository, { ...current, ...seal });
    const excluded = Object.values(stats.excluded).reduce((sum, n) => sum + n, 0);
    changeset = await repository.completePreparation(
      id,
      { status: 'prepared', hash, ...seal, stats, preparedAt: deps.now() },
      event('preparing', 'prepared', { included: stats.included, excluded }),
    );
  } catch (err) {
    if (err instanceof LostRace) return { ok: false, changesetId: id, code: 'cancelled' };
    // Design §4.1: any failure after creation marks the change-set failed with a fixed code.
    const code = err instanceof PreparationFailure ? err.code : 'internal';
    const status = err instanceof PreparationFailure ? err.status : undefined;
    let failed: ChangeSetRecord | undefined;
    try {
      failed = await repository.completePreparation(
        id,
        { status: 'failed', errorCode: code, ...(status === undefined ? {} : { upstreamStatus: status }) },
        event('preparing', 'failed', { errorCode: code }),
      );
    } catch {
      // Marking is best effort; the original error is the one worth reporting.
      throw err;
    }
    if (failed === undefined) return { ok: false, changesetId: id, code: 'cancelled' };
    return { ok: false, changesetId: id, code, ...(status === undefined ? {} : { status }) };
  }
  if (changeset === undefined) return { ok: false, changesetId: id, code: 'cancelled' };
  // Outside the try: once prepared, the change-set must not be marked failed by a later read error.
  const firstItems = await repository.itemsPage(id, { limit: FIRST_ITEMS });
  return { ok: true, changeset, firstItems };
}
