// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ReactElement, ReactNode } from 'react';
import { Notice } from './Notice.js';

/**
 * Code points that do not show as themselves: controls, format characters (bidi overrides and
 * isolates, zero-width characters, U+FEFF, tag characters), line and paragraph separators and
 * spaces other than U+0020. The layout's own newlines and spaces are kept.
 */
const INVISIBLE = /(?![\n ])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu;

function escapeOf(codePoint: number): string {
  const hex = codePoint.toString(16).toUpperCase();
  return codePoint > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
}

/** The text with each invisible code point replaced by a marked `\uXXXX` escape, as React text only. */
function visible(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INVISIBLE)) {
    const at = match.index;
    if (at > last) parts.push(text.slice(last, at));
    // The regex matches exactly one code point, so codePointAt(0) is defined.
    const codePoint = match[0].codePointAt(0) ?? 0;
    const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
    parts.push(
      <span key={at} className="invisible-char" title={label}>
        {escapeOf(codePoint)}
      </span>,
    );
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/**
 * The arguments of an opaque call, as text only (SEC-5, UI-2, APR-5): the call has no preview, so
 * the approver sees exactly what will be sent, with invisible and bidi characters shown as escapes.
 */
export function RawArguments({ args }: { args: Readonly<Record<string, unknown>> }): ReactElement {
  return (
    <section aria-label="Raw arguments">
      <h2>Raw arguments</h2>
      <Notice kind="info">This call has no preview and cannot be rolled back.</Notice>
      <pre>{visible(JSON.stringify(args, null, 2))}</pre>
    </section>
  );
}
