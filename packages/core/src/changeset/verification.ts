// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The verify-after stage (EXE-12, ADR 0073): after the last batch, look again at the written items
 * through the manifest's `verify_after` checks. Read-only upstream; pure apart from the reads. What
 * leaves is a status and a code per item: the record and lookup values read here are dropped (SEC-3).
 */
import type { AuditEventInput } from '../audit.js';
import type { ManifestDefinition, ManifestVerifyAfter } from '../policy-model.js';
import { checkRecordFields, failedCheck, type CheckContext } from './checks.js';
import { PreparationFailure } from './failure.js';
import { manifestAction } from './fields.js';
import { inScope } from './items.js';
import { lookupKey, readLookups } from './lookups.js';
import type { ChangeItemRecord, ChangeSetRecord, VerificationCounts } from './model.js';
import type { UpstreamReader } from './ports.js';
import { readCurrentRecords } from './writer.js';

type Fields = Readonly<Record<string, unknown>>;

/**
 * The fixed verification codes: a chunk whose reads failed (the items stay pending with it), an
 * item still pending at the deadline without a failing check, an item pending when a cancel stopped
 * verification.
 */
export const VERIFICATION_CODES = ['verify_read_failed', 'verify_timeout', 'verify_cancelled'] as const;

/** How verification ended: nothing pending, the deadline passed, or a cancel stopped it. */
export type VerificationEnd = 'done' | 'timeout' | 'cancelled';

/** The result of one look at one item: confirmed, or the code of the first failing check. */
export interface VerificationOutcome {
  readonly targetId: string;
  readonly confirmed: boolean;
  readonly code?: string;
}

const SECOND_MS = 1000;

/** The first look `after_seconds` after `now`, the deadline `timeout_seconds` after `now` (the end of the last batch). */
export function verificationSchedule(v: ManifestVerifyAfter, now: Date): { firstAt: Date; until: Date } {
  return {
    firstAt: new Date(now.getTime() + v.afterSeconds * SECOND_MS),
    until: new Date(now.getTime() + v.timeoutSeconds * SECOND_MS),
  };
}

function isRecord(v: unknown): v is Fields {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sideOf(v: unknown): Fields | null {
  return isRecord(v) ? v : null;
}

/** A read that failed, was truncated or was short: not an error of the look (ADR 0073). */
class VerifyReadFailed extends Error {
  constructor() {
    super('verification read failed');
  }
}

/**
 * One look at a chunk of written items, one outcome per item in input order: read the current
 * records when a check or a lookup key uses `{ record }` (through `read_before`, with the scope
 * filter for an update only), read the verify lookups, evaluate the verify checks in order. A read
 * that is not `ok`, is truncated or holds fewer records than its total makes every item of the
 * chunk `verify_read_failed`; any other error propagates.
 */
export async function verifyChunk(input: {
  manifest: ManifestDefinition & { verifyAfter: ManifestVerifyAfter };
  args: Readonly<Record<string, unknown>>;
  items: readonly Pick<ChangeItemRecord, 'targetId' | 'before' | 'after'>[];
  reader: UpstreamReader;
  readFieldsArg: (operationId: string) => string | undefined;
}): Promise<VerificationOutcome[]> {
  try {
    return await look(input);
  } catch (err) {
    if (err instanceof VerifyReadFailed) {
      return input.items.map((i) => ({ targetId: i.targetId, confirmed: false, code: 'verify_read_failed' }));
    }
    throw err;
  }
}

async function look(input: Parameters<typeof verifyChunk>[0]): Promise<VerificationOutcome[]> {
  const { manifest, args, items, reader } = input;
  const { checks, lookups } = manifest.verifyAfter;
  const records = await currentRecords(input);

  const declared = Object.entries(lookups ?? {});
  const keysByTarget = new Map<string, Map<string, string>>();
  const keysByLookup = new Map<string, string[]>(declared.map(([name]) => [name, []]));
  for (const item of items) {
    const keys = new Map<string, string>();
    const sides = { targetId: item.targetId, before: item.before, after: item.after, record: records?.get(item.targetId) };
    for (const [name, lookup] of declared) {
      const key = lookupKey(lookup, sides);
      if (key === undefined) continue;
      keys.set(name, key);
      keysByLookup.get(name)?.push(key);
    }
    keysByTarget.set(item.targetId, keys);
  }
  let results: Awaited<ReturnType<typeof readLookups>> = new Map();
  if (declared.length > 0) {
    try {
      results = await readLookups({
        // The verify lookups are their own namespace: never the preparation lookups.
        manifest: { ...manifest, lookups: lookups ?? {} },
        args,
        keysByLookup,
        reader,
        readFieldsArg: input.readFieldsArg,
        chunkSize: manifest.batchSize,
      });
    } catch (err) {
      if (err instanceof PreparationFailure && (err.code === 'lookup_failed' || err.code === 'incomplete_read')) throw new VerifyReadFailed();
      throw err;
    }
  }

  return items.map((item): VerificationOutcome => {
    const keys = keysByTarget.get(item.targetId);
    // fromEntries defines own properties, whatever the lookup's name.
    const found: CheckContext['lookups'] = Object.fromEntries(
      declared.map(([name]): [string, Fields | undefined] => {
        const key = keys?.get(name);
        return [name, key === undefined ? undefined : results.get(name)?.get(key)];
      }),
    );
    const code = failedCheck(checks, {
      before: sideOf(item.before),
      after: sideOf(item.after),
      record: records?.get(item.targetId),
      args,
      lookups: found,
    });
    return code === undefined ? { targetId: item.targetId, confirmed: true } : { targetId: item.targetId, confirmed: false, code };
  });
}

/**
 * The current records by target when a verify check or lookup key reads `{ record }`, else
 * `undefined` (nothing is read). An update record outside the call's scope is no record; a create
 * or delete sees every record, whatever its scope (ADR 0071).
 */
async function currentRecords(input: Parameters<typeof verifyChunk>[0]): Promise<ReadonlyMap<string, Fields> | undefined> {
  const { manifest, args } = input;
  const recordFields = checkRecordFields(manifest.verifyAfter.checks, manifest.verifyAfter.lookups);
  if (recordFields.length === 0) return undefined;
  const read = await readCurrentRecords({
    manifest,
    args,
    reader: input.reader,
    readFieldsArg: input.readFieldsArg(manifest.readBefore.operation),
    targetIds: input.items.map((i) => i.targetId),
    // The identifier indexes the records and the scope fields filter an update's.
    fields: [...new Set([manifest.idField, ...Object.values(manifest.scopeArgs), ...recordFields])],
  });
  if (!read.ok || read.shorterThanTotal) throw new VerifyReadFailed();
  if (manifestAction(manifest) !== 'update') return read.records;
  const scoped = new Map<string, Fields>();
  for (const [id, record] of read.records) if (inScope(manifest, args, record)) scoped.set(id, record);
  return scoped;
}

/** The one audit event at the end of verification (EXE-12): how it ended and the counts, never item data (SEC-3). */
export function changesetVerificationEvent(input: {
  id: string;
  changeset: Pick<ChangeSetRecord, 'id' | 'operation'>;
  end: VerificationEnd;
  counts: VerificationCounts;
  actor: string;
  correlationId: string;
}): AuditEventInput {
  return {
    id: input.id,
    actor: input.actor,
    action: 'changeset.verification',
    subject: input.changeset.operation,
    outcome: input.counts.unconfirmed === 0 ? 'ok' : 'error',
    correlationId: input.correlationId,
    changesetId: input.changeset.id,
    details: {
      end: input.end,
      pending: input.counts.pending,
      confirmed: input.counts.confirmed,
      unconfirmed: input.counts.unconfirmed,
      operation: input.changeset.operation,
    },
  };
}
