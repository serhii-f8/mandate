// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { FilePreview } from './model.js';
import { TEXT_PREVIEW_BYTES } from './model.js';

type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const startsWith = (content: Uint8Array, bytes: readonly number[], at = 0): boolean =>
  content.length >= at + bytes.length && bytes.every((b, i) => content[at + i] === b);

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** The image type the leading bytes show, or undefined (CS-10). Never trusts the declared type. */
export function imageTypeOf(content: Uint8Array): ImageType | undefined {
  if (startsWith(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(content, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(content, ascii('GIF87a')) || startsWith(content, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(content, ascii('RIFF')) && startsWith(content, ascii('WEBP'), 8)) return 'image/webp';
  return undefined;
}

const TEXT_TYPES: ReadonlySet<string> = new Set(['text/plain', 'text/csv', 'application/json']);

/** How the approval page may show a file: an image only when its bytes are that image, text only when it is text. */
export function filePreviewKind(mediaType: string, content: Uint8Array): FilePreview {
  if (imageTypeOf(content) === mediaType) return 'image';
  if (!TEXT_TYPES.has(mediaType)) return 'none';
  const head = content.subarray(0, TEXT_PREVIEW_BYTES);
  if (head.includes(0)) return 'none';
  try {
    // stream mode: a sequence cut at the boundary is not an error
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return 'text';
  } catch {
    return 'none';
  }
}
