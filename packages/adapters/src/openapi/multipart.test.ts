// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { FilePart } from '@mandate/connector-sdk';
import { describe, expect, it } from 'vitest';
import { multipartBody, newBoundary } from './multipart.js';
import { MappingError } from './request.js';

const text = (b: Uint8Array): string => Buffer.from(b).toString('latin1');
const part = (over: Partial<FilePart> = {}): FilePart => ({
  name: 'attachment',
  filename: 'a.png',
  mediaType: 'image/png',
  content: new Uint8Array([1, 2, 3]),
  ...over,
});

describe('CONN-9 multipart body', () => {
  it('CONN-9 lays out text fields then file parts exactly as RFC 7578 asks', () => {
    const body = multipartBody({ note: 'hi' }, [part()], 'B');
    const expected =
      '--B\r\nContent-Disposition: form-data; name="note"\r\n\r\nhi\r\n' +
      '--B\r\nContent-Disposition: form-data; name="attachment"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n\x01\x02\x03\r\n' +
      '--B--\r\n';
    expect(text(body)).toBe(expected);
  });

  it('CONN-9 text fields are written in key order, numbers and booleans as text', () => {
    const body = multipartBody({ b: 2, a: true, c: 'x' }, [], 'B');
    expect(text(body)).toBe(
      '--B\r\nContent-Disposition: form-data; name="a"\r\n\r\ntrue\r\n' +
        '--B\r\nContent-Disposition: form-data; name="b"\r\n\r\n2\r\n' +
        '--B\r\nContent-Disposition: form-data; name="c"\r\n\r\nx\r\n--B--\r\n',
    );
  });

  it('CONN-9 a file name with a quote and CR/LF injects no header and no part', () => {
    const body = text(multipartBody({}, [part({ filename: 'a"b\r\nX-Evil: 1.png' }), part({ name: 'second' })], 'B'));
    expect(body).toContain('filename="a%22b%0D%0AX-Evil: 1.png"\r\nContent-Type: image/png\r\n\r\n');
    expect(body.split('\r\n--B')).toHaveLength(3); // one separator per part after the first, plus the closing one
    expect(body.split('\r\n').filter((l) => l.startsWith('X-Evil'))).toEqual([]);
  });

  it('CONN-9 a non-ASCII file name is sent as its UTF-8 bytes', () => {
    const body = multipartBody({}, [part({ filename: 'café.png' })], 'B');
    expect(Buffer.from(body).includes(Buffer.from('filename="café.png"', 'utf8'))).toBe(true);
  });

  it('CONN-9 content that looks like a boundary is passed through and the receiver still sees one file', async () => {
    const boundary = newBoundary();
    const content = Buffer.from(`\r\n--B--\r\n--${boundary.slice(0, 10)}\r\n`);
    const body = multipartBody({ note: 'n' }, [part({ content: new Uint8Array(content) })], boundary);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- test-side parsing: Node's parser is the independent reader
    const form = await new Response(body, { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }).formData();
    expect([...form.keys()]).toEqual(['note', 'attachment']);
    const file = form.get('attachment');
    if (!(file instanceof File)) throw new Error('attachment is not a file');
    expect(Buffer.from(await file.arrayBuffer()).equals(content)).toBe(true);
    expect(file.name).toBe('a.png');
    expect(file.type).toBe('image/png');
  });

  it.each([['a b'], [''], ['a"b'], ['é'], ['x'.repeat(65)]])('CONN-9 a field name %j throws MappingError', (name) => {
    expect(() => multipartBody({ [name]: 'v' }, [], 'B')).toThrow(MappingError);
  });

  it('CONN-9 a part name that does not match throws MappingError', () => {
    expect(() => multipartBody({}, [part({ name: 'a b' })], 'B')).toThrow(MappingError);
  });

  it.each([['image/png\r\nX-Evil: 1'], ['image/\x00png'], ['a\x7f']])('CONN-9 a media type with a control character %j throws MappingError', (mediaType) => {
    expect(() => multipartBody({}, [part({ mediaType })], 'B')).toThrow(MappingError);
  });

  it('CONN-9 newBoundary gives a different mandate-<32 hex> each time', () => {
    const a = newBoundary();
    const b = newBoundary();
    expect(a).toMatch(/^mandate-[0-9a-f]{32}$/);
    expect(b).toMatch(/^mandate-[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
