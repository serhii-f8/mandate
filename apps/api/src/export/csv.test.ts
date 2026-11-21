// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import type { ChangeItemRecord } from '@aiops/core';
import { csvChunks, csvLine } from './csv.js';
import { headerRow } from './columns.js';

async function* pagesOf(...pages: (readonly ChangeItemRecord[])[]): AsyncIterable<readonly ChangeItemRecord[]> {
  for (const page of pages) {
    await Promise.resolve();
    yield page;
  }
}

async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe('CS-8 CSV writer', () => {
  it('CS-8 CSV is UTF-8 with BOM, every field quoted, CRLF after every line', async () => {
    const chunks = await collect(
      csvChunks(['note'], pagesOf([{ targetId: 't-1', status: 'pending', before: null, after: { note: 'he said "hi"\nok' } }], [
        { targetId: 't-2', status: 'failed', error: 'e', before: { note: 1 }, after: null },
      ])),
    );
    expect(chunks).toHaveLength(3);
    expect(chunks.join('')).toBe(
      '﻿"target_id","status","reason","error","before.note","after.note"\r\n' +
        '"t-1","pending","","","","he said ""hi""\nok"\r\n' +
        '"t-2","failed","","e","1",""\r\n',
    );
  });

  it('SEC-5 CSV prefixes formula cells, including header cells', async () => {
    const chunks = await collect(
      csvChunks(['=cmd'], pagesOf([{ targetId: '@t', status: 'pending', before: { '=cmd': '+x' }, after: { '=cmd': '-1' } }])),
    );
    const [header, rows] = chunks;
    // The field `=cmd` gives `before.=cmd`, which does not start with a trigger character (F5).
    expect(header).toBe('﻿' + csvLine(headerRow(['=cmd'])));
    expect(header).toContain('"before.=cmd","after.=cmd"');
    // Header and item cells share csvLine, so a header cell that starts with `=` gets the prefix.
    expect(csvLine(['=cmd', 'ok'])).toBe(`"'=cmd","ok"\r\n`);
    expect(rows).toBe(`"'@t","pending","","","'+x","'-1"\r\n`);
  });

  it('SEC-5 CSV truncates before the prefix check', () => {
    const line = csvLine(['=' + 'x'.repeat(40_000)]);
    expect(line.startsWith(`"'=xxx`)).toBe(true);
    expect(line).toHaveLength(2 + 1 + 32_762 + 2);
  });
});
