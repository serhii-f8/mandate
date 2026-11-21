// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
/** CSV export of a change-set (CS-8): RFC 4180, UTF-8 with BOM, every field quoted, CRLF. */
import type { ChangeItemRecord } from '@aiops/core';
import { formulaSafe, headerRow, itemRow, truncateCell } from './columns.js';

const BOM = '﻿';

/** One CSV line: each cell truncated, then formula-prefixed (SEC-5), then quoted; ends with CRLF. */
export function csvLine(cells: readonly string[]): string {
  return cells.map((cell) => `"${formulaSafe(truncateCell(cell)).replaceAll('"', '""')}"`).join(',') + '\r\n';
}

/** Yields the BOM plus the header line, then one chunk per page of items. */
export async function* csvChunks(
  fields: readonly string[],
  pages: AsyncIterable<readonly ChangeItemRecord[]>,
): AsyncGenerator<string> {
  yield BOM + csvLine(headerRow(fields));
  for await (const page of pages) {
    if (page.length === 0) continue;
    yield page.map((item) => csvLine(itemRow(item, fields))).join('');
  }
}
