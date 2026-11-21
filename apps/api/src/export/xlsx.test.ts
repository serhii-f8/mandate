// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import type { ChangeItemRecord } from '@aiops/core';
import { xlsxChunks } from './xlsx.js';

async function* pagesOf(...pages: (readonly ChangeItemRecord[])[]): AsyncIterable<readonly ChangeItemRecord[]> {
  for (const page of pages) {
    await Promise.resolve();
    yield page;
  }
}

async function unzip(fields: readonly string[], pages: AsyncIterable<readonly ChangeItemRecord[]>): Promise<Record<string, string>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of xlsxChunks(fields, pages)) chunks.push(chunk);
  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }
  const files = unzipSync(joined);
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strFromU8(data)]));
}

const sheetOf = (files: Record<string, string>): string => files['xl/worksheets/sheet1.xml'] ?? '';

describe('CS-8 XLSX writer', () => {
  it('CS-8 XLSX holds one sheet Items with a bold header and inline strings only', async () => {
    const files = await unzip(['a'], pagesOf([{ targetId: 't-1', status: 'pending', before: { a: 1 }, after: { a: 2 } }]));
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    expect(files['xl/workbook.xml']).toContain('<sheet name="Items" sheetId="1" r:id="rId1"/>');
    expect(files['xl/styles.xml']).toContain('<cellXfs count="2">');
    expect(files['xl/styles.xml']).toContain('<b/>');
    const sheet = sheetOf(files);
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).not.toContain('<f>');
    expect(sheet).not.toContain('t="s"');
    const [header, row] = [...sheet.matchAll(/<row[^>]*>(.*?)<\/row>/g)].map((m) => m[1] ?? '');
    expect(header?.match(/<c /g)).toHaveLength(6);
    expect(header?.match(/s="1"/g)).toHaveLength(6);
    expect(header).toContain('<t xml:space="preserve">before.a</t>');
    expect(row).not.toContain('s="1"');
    expect(row).toContain('<c r="E2" t="inlineStr"><is><t xml:space="preserve">1</t></is></c>');
  });

  it('SEC-5 XLSX drops XML-illegal characters before the formula check', async () => {
    const files = await unzip(['a'], pagesOf([{ targetId: 't-1', status: 'pending', before: null, after: { a: '\u0001=HYPERLINK("x")' } }]));
    expect(sheetOf(files)).toContain(`<t xml:space="preserve">'=HYPERLINK(&quot;x&quot;)</t>`);
  });

  it('CS-8 XLSX escapes markup and keeps the row count', async () => {
    const files = await unzip(
      ['a'],
      pagesOf(
        [{ targetId: 't-1', status: 'pending', before: null, after: { a: '<b>&</b>' } }],
        [
          { targetId: 't-2', status: 'pending', before: null, after: null },
          { targetId: 't-3', status: 'pending', before: null, after: null },
        ],
      ),
    );
    const sheet = sheetOf(files);
    expect(sheet).toContain('&lt;b&gt;&amp;&lt;/b&gt;');
    expect(sheet).not.toContain('<b>');
    expect(sheet.match(/<row/g)).toHaveLength(4);
  });

  it('SEC-5 XLSX truncates a long cell after stripping', async () => {
    const files = await unzip(['a'], pagesOf([{ targetId: 't-1', status: 'pending', before: null, after: { a: '\u0000'.repeat(10) + 'x'.repeat(40_000) } }]));
    expect(sheetOf(files)).toContain(`${'x'.repeat(32_750)}…[truncated]</t>`);
  });
});
