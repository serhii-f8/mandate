// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import type { ChangeItemRecord, ItemsPageQuery } from '@aiops/core';
import {
  CELL_LIMIT,
  EXPORT_PAGE,
  TRUNCATED,
  cellText,
  collectFields,
  formulaSafe,
  headerRow,
  itemPages,
  itemRow,
  stripXmlIllegal,
  truncateCell,
} from './columns.js';

async function* pagesOf(...pages: (readonly ChangeItemRecord[])[]): AsyncIterable<readonly ChangeItemRecord[]> {
  for (const page of pages) {
    await Promise.resolve();
    yield page;
  }
}

const item = (targetId: string, before: unknown, after: unknown, extra: Partial<ChangeItemRecord> = {}): ChangeItemRecord => ({
  targetId,
  status: 'pending',
  before,
  after,
  ...extra,
});

describe('CS-8 export columns and cells', () => {
  it('CS-8 fields from every before and after, sorted, interleaved after the fixed columns', async () => {
    const fields = await collectFields(pagesOf([item('t-1', { b: 1 }, { a: 'x' })], [item('t-2', null, { a: 'y' })]));
    expect(fields).toEqual(['a', 'b']);
    expect(headerRow(fields)).toEqual(['target_id', 'status', 'reason', 'error', 'before.a', 'after.a', 'before.b', 'after.b']);
  });

  it('CS-8 fields are ordered by code point, not by locale', async () => {
    const fields = await collectFields(pagesOf([item('t-1', { b: 1, B: 2, 'é': 3, '😀': 4 }, null)]));
    expect(fields).toEqual(['B', 'b', 'é', '😀']);
  });

  it('CS-8 strings as they are, other values as canonical JSON, missing as empty', () => {
    expect(cellText({ z: 1, a: [true] })).toBe('{"a":[true],"z":1}');
    expect(cellText('plain "text"')).toBe('plain "text"');
    expect(cellText(undefined)).toBe('');
    expect(cellText(null)).toBe('null');
    expect(cellText(12.5)).toBe('12.5');
    const row = itemRow(
      item('t-1', null, { a: 'x', b: { z: 1, a: [true] } }, { status: 'excluded', reason: 'requester', error: 'boom' }),
      ['a', 'b', 'c'],
    );
    expect(row).toEqual(['t-1', 'excluded', 'requester', 'boom', '', 'x', '', '{"a":[true],"z":1}', '', '']);
    expect(itemRow(item('t-2', { a: 1 }, { a: 2 }), ['a'])).toEqual(['t-2', 'pending', '', '', '1', '2']);
  });

  it('CS-8 a field named like a prototype property is read only as an own property', () => {
    expect(itemRow(item('t-1', {}, { toString: 'x' }), ['toString'])).toEqual(['t-1', 'pending', '', '', '', 'x']);
  });

  it('CS-8 a cell over 32767 is cut to 32750 plus the marker', () => {
    const cut = truncateCell('x'.repeat(40_000));
    expect(cut).toHaveLength(32_762);
    expect(cut.endsWith(TRUNCATED)).toBe(true);
    expect(cut.slice(0, 32_750)).toBe('x'.repeat(32_750));
    expect(truncateCell('x'.repeat(CELL_LIMIT))).toBe('x'.repeat(CELL_LIMIT));
  });

  it('CS-8 truncation never splits a surrogate pair', () => {
    const cut = truncateCell('a' + '😀'.repeat(20_000));
    expect(cut).toHaveLength(32_761);
    const body = cut.slice(0, -TRUNCATED.length);
    const last = body.charCodeAt(body.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(() => encodeURIComponent(cut)).not.toThrow();
  });

  it('SEC-5 formula prefixes for = + - @ tab and CR', () => {
    for (const text of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(formulaSafe(text)).toBe(`'${text}`);
    expect(formulaSafe('a=b')).toBe('a=b');
    expect(formulaSafe('1-2')).toBe('1-2');
    expect(formulaSafe('')).toBe('');
    expect(formulaSafe('\nx')).toBe('\nx');
  });

  it('SEC-5 XML-illegal characters are dropped, legal ones kept', () => {
    expect(stripXmlIllegal('a\u0000b\u0001c\u000bd\u001fe￾f￿g')).toBe('abcdefg');
    expect(stripXmlIllegal('\t\n\r x퟿�😀')).toBe('\t\n\r x퟿�😀');
    expect(stripXmlIllegal('a\ud800b\udc00c')).toBe('abc');
  });

  it('NFR-7 itemPages reads pages of 500 by cursor', async () => {
    const all = Array.from({ length: 1_001 }, (_, i) => item(`t-${String(i).padStart(4, '0')}`, null, null));
    const calls: ItemsPageQuery[] = [];
    const repo = {
      itemsPage: (id: string, query: ItemsPageQuery): Promise<readonly ChangeItemRecord[]> => {
        expect(id).toBe('cs-1');
        calls.push(query);
        const start = query.after === undefined ? 0 : all.findIndex((i) => i.targetId === query.after) + 1;
        return Promise.resolve(all.slice(start, start + query.limit));
      },
    };
    const seen: string[] = [];
    for await (const page of itemPages(repo, 'cs-1')) for (const i of page) seen.push(i.targetId);
    expect(EXPORT_PAGE).toBe(500);
    expect(calls).toEqual([{ limit: 500 }, { limit: 500, after: 't-0499' }, { limit: 500, after: 't-0999' }]);
    expect(seen).toEqual(all.map((i) => i.targetId));
  });
});
