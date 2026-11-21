// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { ReadOutcome } from '@aiops/connector-sdk';
import type { Scrubber } from '../http/scrub.js';

/** The fixed message of a tool result with `isError: true`; the upstream's own text is never copied (SEC-5). */
export const TOOL_ERROR_MESSAGE = 'upstream tool reported an error';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Maps a `tools/call` result to a read outcome (SEC-5). Pure. The text of every `text` block is
 * kept in order, every other block (image, audio, resource, resource_link, anything unknown) is
 * only counted in `omitted`, `structuredContent` is kept when it is a plain object, and `_meta` is
 * dropped at every level. Every string is scrubbed (SEC-3). `isError: true` becomes
 * `upstream_error` with a fixed message.
 */
export function mapToolResult(result: unknown, scrubber: Scrubber, durationMs: number): ReadOutcome {
  // Checked first: an error result is an error whatever its content looks like.
  if (isPlainObject(result) && result.isError === true) return { ok: false, code: 'upstream_error', durationMs, message: TOOL_ERROR_MESSAGE };
  if (!isPlainObject(result) || !Array.isArray(result.content)) {
    return { ok: false, code: 'invalid_response', durationMs, message: 'upstream tool returned an unusable result' };
  }
  const text: string[] = [];
  let omitted = 0;
  for (const block of result.content as readonly unknown[]) {
    if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') text.push(scrubber.text(block.text));
    else omitted += 1;
  }
  const structured = isPlainObject(result.structuredContent) ? scrubber.deep(result.structuredContent) : null;
  return { ok: true, status: 200, durationMs, truncated: false, value: { structured, text, omitted } };
}
