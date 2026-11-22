// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { Caller } from '../caller.js';
import { changesetTransitionEvent } from './audit.js';
import { isKnownHashVersion } from './hash.js';
import { isExpiryDue } from './lifecycle.js';
import type { ChangeSetRecord, ChangeSetStatus } from './model.js';
import type { ChangeSetRepository } from './ports.js';
import { hashStoredItems } from './verify.js';

/** CS-5: the most target IDs one derivation may name in `exclude` and `include` together (ADR 0036 R1). */
export const MAX_DERIVE_TARGETS = 1000;

const MAX_TARGET_ID_LENGTH = 512;
/** A control character, or (under the `u` flag) a lone surrogate: the same test as `!isWellFormed()` (ruling F6). */
const BAD_TARGET_CHAR = /[\p{Cc}\p{Cs}]/u;

/**
 * A target ID a derivation accepts: 1..512 UTF-16 units, well-formed UTF-16 and no `\p{Cc}` character.
 * A lone surrogate would make the database's JSON cast fail, so it is refused here (ruling F6).
 */
export function isValidTargetId(id: string): boolean {
  return id.length >= 1 && id.length <= MAX_TARGET_ID_LENGTH && !BAD_TARGET_CHAR.test(id);
}

export type DeriveRepository = Pick<
  ChangeSetRepository,
  'get' | 'transition' | 'create' | 'deriveCheck' | 'copyItems' | 'stats' | 'itemsPage' | 'completePreparation'
>;

export interface DeriveDeps {
  readonly repository: DeriveRepository;
  readonly newId: () => string;
  readonly now: () => Date;
}

export interface DeriveRequest {
  readonly sourceId: string;
  readonly hash: string;
  readonly exclude: readonly string[];
  readonly include: readonly string[];
  readonly caller: Caller;
  readonly correlationId: string;
  /** Whether the source's operation has items to exclude; an opaque operation does not (CS-5, design §2). */
  readonly excludable: (operationId: string) => boolean;
}

export type DeriveRefusal =
  | { readonly reason: 'not_found' | 'not_excludable' | 'expired' | 'hash_mismatch' | 'invalid_request' | 'empty_request' | 'nothing_left' }
  | { readonly reason: 'not_prepared'; readonly status: ChangeSetStatus }
  | { readonly reason: 'unknown_items'; readonly count: number };

export type DeriveOutcome =
  | {
      readonly ok: true;
      readonly changeset: ChangeSetRecord;
      readonly source: ChangeSetRecord;
      readonly excludedByRequester: number;
    }
  | ({ readonly ok: false } & DeriveRefusal);

/**
 * CS-5: a new change-set from a prepared source with the requester's exclusions applied (design §2.2).
 * The source is never changed; the new row keeps the source's request and expiry, gets its own ID and
 * its hash from the stored items (CS-4). Refusals come in the fixed order of the plan's Global Constraints.
 */
export async function deriveChangeSet(deps: DeriveDeps, req: DeriveRequest): Promise<DeriveOutcome> {
  const { repository } = deps;
  const { caller, correlationId } = req;

  // 1. Unknown and foreign change-sets look the same (SEC-1).
  const source = await repository.get(req.sourceId);
  if (source?.requester !== caller.subject) return { ok: false, reason: 'not_found' };
  // 2. An opaque change-set has no items to exclude (CS-5); after the requester check, so a foreign one stays not_found.
  if (!req.excludable(source.operation)) return { ok: false, reason: 'not_excludable' };

  // 3. Lazy expiry (CS-6): a miss means someone else moved it first; it is past its expiry either way.
  const now = deps.now();
  if (isExpiryDue(source, now)) {
    await repository.transition(
      source.id,
      [source.status],
      'expired',
      changesetTransitionEvent({
        id: deps.newId(),
        actor: 'system',
        changeset: source,
        from: source.status,
        to: 'expired',
        correlationId,
      }),
      { expiredBefore: now },
    );
    return { ok: false, reason: 'expired' };
  }

  // 4–5.
  if (source.status !== 'prepared') return { ok: false, reason: 'not_prepared', status: source.status };
  if (source.hash !== req.hash) return { ok: false, reason: 'hash_mismatch' };
  // CS-4: a seal this release cannot recompute is a mismatch, refused before any row is created.
  if (!isKnownHashVersion(source.hashVersion ?? 1)) return { ok: false, reason: 'hash_mismatch' };

  // 6–7.
  if (req.exclude.length + req.include.length > MAX_DERIVE_TARGETS) return { ok: false, reason: 'invalid_request' };
  if (!req.exclude.every(isValidTargetId) || !req.include.every(isValidTargetId)) {
    return { ok: false, reason: 'invalid_request' };
  }
  if (req.exclude.length === 0 && req.include.length === 0) return { ok: false, reason: 'empty_request' };

  // 8–9. No lock on the source: its items are immutable once it is prepared (CS-4, the update
  // trigger), so a concurrent submission of the source cannot change what is counted or copied (F17).
  const check = await repository.deriveCheck(source.id, req.exclude, req.include);
  if (check.unknown > 0) return { ok: false, reason: 'unknown_items', count: check.unknown };
  if (check.includedAfter === 0) return { ok: false, reason: 'nothing_left' };

  const id = deps.newId();
  const ref = { id, operation: source.operation };
  const actor = {
    actor: caller.subject,
    ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
  };
  await repository.create(
    {
      id,
      operation: source.operation,
      connection: source.connection,
      requester: source.requester,
      ...(caller.clientId === undefined ? {} : { clientId: caller.clientId }),
      args: source.args,
      configHash: source.configHash,
      correlationId,
      createdAt: now,
      // A derived change-set never outlives its source (CS-6).
      expiresAt: source.expiresAt,
      derivedFrom: source.id,
    },
    changesetTransitionEvent({
      id: deps.newId(),
      ...actor,
      changeset: ref,
      from: null,
      to: 'preparing',
      correlationId,
      details: { derivedFrom: source.id },
    }),
  );
  await repository.copyItems(id, source.id, req.exclude, req.include);

  const stats = await repository.stats(id);
  // CS-4: a derived change-set keeps its source's seal, so a version 1 source derives version 1 (ADR 0069).
  const seal = {
    hashVersion: source.hashVersion ?? 1,
    ...(source.action === undefined ? {} : { action: source.action }),
  };
  const hash = await hashStoredItems(repository, { id, operation: source.operation, args: source.args, ...seal });
  const excluded = Object.values(stats.excluded).reduce((sum, n) => sum + n, 0);
  const excludedByRequester = stats.excluded.requester ?? 0;
  const changeset = await repository.completePreparation(
    id,
    { status: 'prepared', hash, ...seal, stats, preparedAt: deps.now() },
    changesetTransitionEvent({
      id: deps.newId(),
      ...actor,
      changeset: ref,
      from: 'preparing',
      to: 'prepared',
      correlationId,
      details: { included: stats.included, excluded, derivedFrom: source.id, excludedByRequester },
    }),
  );
  // The only way out of preparing under us is expiry together with the source.
  if (changeset === undefined) return { ok: false, reason: 'expired' };
  return { ok: true, changeset, source, excludedByRequester };
}
