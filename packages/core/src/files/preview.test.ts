// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { describe, expect, it } from 'vitest';
import { filePreviewKind, imageTypeOf } from './preview.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

describe('CS-10 file preview kind', () => {
  it('shows an image only when the bytes are the declared image type', () => {
    expect(filePreviewKind('image/png', png)).toBe('image');
    expect(filePreviewKind('image/jpeg', png)).toBe('none');
    expect(filePreviewKind('image/png', enc('<svg onload=alert(1)>'))).toBe('none');
    expect(filePreviewKind('image/svg+xml', enc('<svg/>'))).toBe('none');
    expect(filePreviewKind('text/html', enc('<b>x</b>'))).toBe('none');
  });

  it('recognises the four image signatures', () => {
    expect(imageTypeOf(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(imageTypeOf(enc('GIF87a..'))).toBe('image/gif');
    expect(imageTypeOf(enc('GIF89a..'))).toBe('image/gif');
    expect(imageTypeOf(enc('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(imageTypeOf(enc('RIFF\0\0\0\0WAVEfmt '))).toBeUndefined();
    expect(imageTypeOf(png)).toBe('image/png');
    expect(imageTypeOf(new Uint8Array())).toBeUndefined();
  });

  it('previews text only for text types that decode as UTF-8 without NUL', () => {
    expect(filePreviewKind('text/csv', enc('sku,price\nA,1\n'))).toBe('text');
    expect(filePreviewKind('application/json', enc('{"a":1}'))).toBe('text');
    expect(filePreviewKind('text/plain', Uint8Array.from([0x61, 0x00, 0x62]))).toBe('none');
    expect(filePreviewKind('text/plain', Uint8Array.from([0xff, 0xfe]))).toBe('none');
  });

  it('does not fail a multi-byte character cut at the preview boundary', () => {
    const bytes = new Uint8Array(65_536 + 3);
    bytes.fill(0x61);
    bytes.set(enc('😀'), 65_534); // 4 bytes straddling byte 65536
    expect(filePreviewKind('text/plain', bytes)).toBe('text');
  });

  it('judges only the first 65536 bytes', () => {
    const bytes = new Uint8Array(65_540).fill(0x61);
    bytes[65_537] = 0;
    expect(filePreviewKind('text/plain', bytes)).toBe('text');
  });
});
