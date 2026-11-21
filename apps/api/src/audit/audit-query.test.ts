// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { encodeItemCursor } from '../approvals/page-query.js';
import { encodeAuditCursor, parseAuditExportQuery, parseAuditSearchQuery } from './audit-query.js';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('AUD-6 NFR-8 audit query', () => {
  it('AUD-6 accepts every filter and gives sorted filter names', () => {
    const parsed = parseAuditSearchQuery({
      to: '2026-11-19T00:00:00.000Z',
      actor: "a%'b",
      action: 'approval.decision',
      outcome: 'denied',
      changeset: UUID.toUpperCase(),
      correlation: 'c'.repeat(128),
      from: '2026-11-18T00:00:00.000Z',
      cursor: encodeAuditCursor('9223372036854775807'),
      limit: '100',
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        filter: {
          actor: "a%'b",
          action: 'approval.decision',
          outcome: 'denied',
          changesetId: UUID,
          correlationId: 'c'.repeat(128),
          from: new Date('2026-11-18T00:00:00.000Z'),
          to: new Date('2026-11-19T00:00:00.000Z'),
        },
        filterNames: ['action', 'actor', 'changeset', 'correlation', 'from', 'outcome', 'to'],
        limit: 100,
        beforeSeq: '9223372036854775807',
      },
    });
    expect(parseAuditSearchQuery({})).toEqual({ ok: true, value: { filter: {}, filterNames: [], limit: 50 } });
    expect(parseAuditSearchQuery({ actor: 'x'.repeat(255), limit: '1' })).toEqual({
      ok: true,
      value: { filter: { actor: 'x'.repeat(255) }, filterNames: ['actor'], limit: 1 },
    });
    expect(parseAuditExportQuery({ outcome: 'ok' })).toEqual({
      ok: true,
      value: { filter: { outcome: 'ok' }, filterNames: ['outcome'] },
    });
    expect(encodeAuditCursor('42')).toBe(encodeItemCursor('42'));
  });

  it.each<[string, Record<string, unknown>]>([
    ['actor empty', { actor: '' }],
    ['actor of 256 characters', { actor: 'a'.repeat(256) }],
    ['actor with NUL', { actor: 'a\u0000b' }],
    ['unknown action', { action: 'nope' }],
    ['unknown outcome', { outcome: 'maybe' }],
    ['changeset not a UUID', { changeset: 'x' }],
    ['correlation empty', { correlation: '' }],
    ['correlation of 129 characters', { correlation: 'c'.repeat(129) }],
    ['correlation with a newline', { correlation: 'a\nb' }],
    ['from that does not round-trip', { from: '2026-11-18' }],
    ['to that is no date', { to: '2026-02-30T00:00:00.000Z' }],
    ['from with an expanded negative year', { from: '-271821-04-20T00:00:00.000Z' }],
    ['to with an expanded positive year', { to: '+275760-09-13T00:00:00.000Z' }],
    ['actor with a C1 control character', { actor: 'a\u0085b' }],
    ['correlation with a C1 control character', { correlation: 'a\u009fb' }],
    ['cursor not canonical', { cursor: 'QQ==' }],
    ['cursor decoding to 0', { cursor: encodeItemCursor('0') }],
    ['cursor decoding to abc', { cursor: encodeItemCursor('abc') }],
    ['cursor with a leading zero', { cursor: encodeItemCursor('012') }],
    ['cursor above the bigint range', { cursor: encodeItemCursor('9999999999999999999') }],
    ['cursor one above the bigint maximum', { cursor: encodeItemCursor('9223372036854775808') }],
    ['limit 0', { limit: '0' }],
    ['limit 101', { limit: '101' }],
    ['limit 1.5', { limit: '1.5' }],
    ['unknown key', { sort: 'seq' }],
    ['repeated actor', { actor: ['a', 'b'] }],
    ['actor object from actor[a]=1', { actor: { a: '1' } }],
    ['limit object', { limit: { a: '1' } }],
    ['cursor array', { cursor: ['MQ'] }],
    ['number value', { outcome: 1 }],
  ])('AUD-6 refuses malformed values: %s', (_name, query) => {
    expect(parseAuditSearchQuery(query)).toEqual({ ok: false });
  });

  it('AUD-6 the export refuses cursor and limit', () => {
    expect(parseAuditExportQuery({ cursor: encodeItemCursor('5') })).toEqual({ ok: false });
    expect(parseAuditExportQuery({ limit: '10' })).toEqual({ ok: false });
    expect(parseAuditExportQuery({ actor: { a: '1' } })).toEqual({ ok: false });
    expect(parseAuditExportQuery({ from: '2026-11-18' })).toEqual({ ok: false });
  });
});
