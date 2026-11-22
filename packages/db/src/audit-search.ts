// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { AuditReader, AuditRecord, AuditSearchFilter } from '@mandate/core';
import type pg from 'pg';
import { CHAIN_COLUMNS, chainFields, safeInteger } from './audit-chain.js';
import { guarded } from './errors.js';

/** A row selected with `CHAIN_COLUMNS` as a search answers it: the chain fields plus `chainPos`. */
function toRecord(row: Record<string, unknown>): AuditRecord {
  const { details, ...fields } = chainFields(row);
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    throw new Error('audit row column details is not an object');
  }
  const pos = row.pos;
  if (pos !== null && typeof pos !== 'string') throw new Error('audit row column pos is not text');
  return {
    ...fields,
    details: details as Record<string, unknown>,
    chainPos: pos === null ? null : safeInteger(pos, 'chain_pos'),
  };
}

/**
 * Audit search over `audit_event` (AUD-6, NFR-8): parameterised equality filters combined with AND,
 * newest first by `seq`, keyset-paged with `beforeSeq`. Values arrive validated by the API's query
 * parser; every one is a bind parameter, so quotes and `%` are literals. Errors leave without the
 * statement or its parameters (SEC-3).
 */
export class PostgresAuditReader implements AuditReader {
  constructor(private readonly pool: pg.Pool) {}

  async search(
    filter: AuditSearchFilter,
    page: { readonly limit: number; readonly beforeSeq?: string },
  ): Promise<{ events: AuditRecord[]; more: boolean }> {
    if (!Number.isSafeInteger(page.limit) || page.limit < 1) throw new Error('limit must be a positive integer');
    if (page.beforeSeq !== undefined && !/^[1-9][0-9]{0,18}$/.test(page.beforeSeq)) {
      throw new Error('beforeSeq must be a positive decimal integer');
    }
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (condition: (placeholder: string) => string, value: unknown): void => {
      params.push(value);
      where.push(condition(`$${params.length}`));
    };
    if (filter.actor !== undefined) add((p) => `actor = ${p}`, filter.actor);
    if (filter.action !== undefined) add((p) => `action = ${p}`, filter.action);
    if (filter.outcome !== undefined) add((p) => `outcome = ${p}`, filter.outcome);
    if (filter.changesetId !== undefined) add((p) => `changeset_id = ${p}::uuid`, filter.changesetId);
    if (filter.correlationId !== undefined) add((p) => `correlation_id = ${p}`, filter.correlationId);
    if (filter.from !== undefined) add((p) => `ts >= ${p}`, filter.from);
    if (filter.to !== undefined) add((p) => `ts < ${p}`, filter.to);
    // Qualified: a bare `seq` would bind to the `seq::text` output column and compare as text.
    if (page.beforeSeq !== undefined) add((p) => `audit_event.seq < ${p}::bigint`, page.beforeSeq);
    params.push(page.limit + 1);
    const sql =
      `SELECT ${CHAIN_COLUMNS} FROM audit_event` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY audit_event.seq DESC LIMIT $${params.length}`;
    const result = await guarded('audit search', () => this.pool.query<Record<string, unknown>>(sql, params));
    const more = result.rows.length > page.limit;
    return { events: result.rows.slice(0, page.limit).map(toRecord), more };
  }
}
