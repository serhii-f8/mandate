// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * XLSX export of a change-set (CS-8): a minimal SpreadsheetML workbook with one sheet `Items`,
 * streamed into a ZIP with fflate. Every cell is an inline string, so nothing is a formula (SEC-5).
 */
import { Zip, ZipDeflate, strToU8 } from 'fflate';
import type { ChangeItemRecord } from '@mandate/core';
import { formulaSafe, headerRow, itemRow, stripXmlIllegal, truncateCell } from './columns.js';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const STATIC_PARTS: readonly (readonly [string, string])[] = [
  [
    '[Content_Types].xml',
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',
  ],
  [
    '_rels/.rels',
    `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
      '</Relationships>',
  ],
  [
    'xl/workbook.xml',
    `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
      '<sheets><sheet name="Items" sheetId="1" r:id="rId1"/></sheets></workbook>',
  ],
  [
    'xl/_rels/workbook.xml.rels',
    `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">` +
      `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/>` +
      '</Relationships>',
  ],
  [
    'xl/styles.xml',
    `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">` +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>',
  ],
];

const SHEET_OPEN = `${XML_HEAD}<worksheet xmlns="${MAIN_NS}"><sheetData>`;
const SHEET_CLOSE = '</sheetData></worksheet>';

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** A1-style column letters for a zero-based column index. */
function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** One row; per cell: drop XML-illegal characters, truncate, prefix (SEC-5), escape. */
function rowXml(cells: readonly string[], rowNumber: number, bold: boolean): string {
  const style = bold ? ' s="1"' : '';
  const body = cells
    .map((cell, i) => {
      const text = escapeXml(formulaSafe(truncateCell(stripXmlIllegal(cell))));
      return `<c r="${columnName(i)}${rowNumber}" t="inlineStr"${style}><is><t xml:space="preserve">${text}</t></is></c>`;
    })
    .join('');
  return `<row r="${rowNumber}">${body}</row>`;
}

/** Yields the bytes of the workbook; the sheet is deflated with one push per page (NFR-7). */
export async function* xlsxChunks(
  fields: readonly string[],
  pages: AsyncIterable<readonly ChangeItemRecord[]>,
): AsyncGenerator<Uint8Array> {
  const queue: Uint8Array[] = [];
  let failure: Error | undefined;
  // An object, so the check after the loop is not narrowed to the initial value.
  const zipState = { done: false };
  const zip = new Zip((err, data, final) => {
    if (err !== null) {
      failure = err;
      return;
    }
    queue.push(data);
    if (final) zipState.done = true;
  });
  // fflate's ZipDeflate and Zip are synchronous: every push runs the callback before it returns.
  function* drain(): Generator<Uint8Array> {
    if (failure !== undefined) throw failure;
    while (queue.length > 0) {
      const chunk = queue.shift();
      if (chunk !== undefined && chunk.length > 0) yield chunk;
    }
  }

  for (const [name, content] of STATIC_PARTS) {
    const part = new ZipDeflate(name, { level: 6 });
    zip.add(part);
    part.push(strToU8(content), true);
  }
  const sheet = new ZipDeflate('xl/worksheets/sheet1.xml', { level: 6 });
  zip.add(sheet);
  sheet.push(strToU8(SHEET_OPEN + rowXml(headerRow(fields), 1, true)));
  yield* drain();

  let rowNumber = 1;
  for await (const page of pages) {
    if (page.length === 0) continue;
    const xml = page.map((item) => rowXml(itemRow(item, fields), ++rowNumber, false)).join('');
    sheet.push(strToU8(xml));
    yield* drain();
  }
  sheet.push(strToU8(SHEET_CLOSE), true);
  zip.end();
  yield* drain();
  if (!zipState.done) throw new Error('xlsx: the ZIP stream did not finish');
}
