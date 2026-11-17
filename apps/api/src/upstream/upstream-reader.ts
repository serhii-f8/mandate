/**
 * The `api` implementation of the core `UpstreamReader` port (design §4.2): the reads a
 * manifest asks for while preparing a change-set. It runs the Phase 3 read path without a
 * policy decision (the write operation's decision covers its reads), but insists on a
 * `read` operation bound to GET (CS-1 in code, not only in configuration) and on arguments
 * the read operation's own validator accepts.
 */
import type { ReadOutcome } from '@aiops/connector-sdk';
import type { ReadPage, UpstreamReader } from '@aiops/core';
import { performRead, type SingleReadDeps } from './read-invoker.js';

export type UpstreamReaderDeps = SingleReadDeps & { readonly correlationId: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function toPage(outcome: ReadOutcome): ReadPage {
  // The adapter's message stays behind: only the fixed code and status (SEC-3).
  if (!outcome.ok) return { ok: false, code: outcome.code, ...(outcome.status === undefined ? {} : { status: outcome.status }) };
  const items = outcome.items ?? (isRecord(outcome.value) ? [outcome.value] : []);
  return { ok: true, items, ...(outcome.total === undefined ? {} : { total: outcome.total }), truncated: outcome.truncated };
}

/** A reader bound to one request's configuration snapshot and correlation ID (SEC-1). */
export function createUpstreamReader(deps: UpstreamReaderDeps): UpstreamReader {
  const { configuration } = deps;
  return {
    async read(operationId, args) {
      const operation = configuration.policy.operations.find((o) => o.id === operationId);
      if (operation?.risk !== 'read') return { ok: false, code: 'not_readable' };
      // A manifest cannot produce a request the read operation itself would refuse.
      const check = configuration.validators.get(operationId)?.(args);
      if (check?.ok !== true) return { ok: false, code: 'invalid_read_arguments' };
      const read = await performRead(deps, operationId, args);
      if (!read.ok) return { ok: false, code: read.code === 'not_get' ? 'not_readable' : read.code };
      return toPage(read.outcome);
    },
  };
}
