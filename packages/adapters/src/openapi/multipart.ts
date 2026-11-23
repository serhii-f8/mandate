// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { randomBytes } from 'node:crypto';
import type { FilePart } from '@mandate/connector-sdk';
import { MappingError } from './request.js';
import { isPlainObject } from './schema-translate.js';

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** A fresh boundary per request: `mandate-` and 32 hex digits (RFC 2046 allows up to 70 characters). */
export function newBoundary(): string {
  return `mandate-${randomBytes(16).toString('hex')}`;
}

/** A quoted-string value in a `Content-Disposition` header: `"`, CR and LF are percent-escaped (WHATWG form-data rule). */
function quoted(value: string): string {
  return value.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function checkName(name: string): void {
  if (!NAME.test(name)) throw new MappingError('a multipart field name is not allowed');
}

/**
 * The body of a `multipart/form-data` request (RFC 7578): the text fields in key order, then the
 * file parts in order, closed by the final boundary. File content is copied as is. Field and part
 * names must match `^[A-Za-z0-9_.-]{1,64}$` (else `MappingError`); a file name is sent as UTF-8
 * with `"`, CR and LF escaped, so it can neither end its header nor start another. A media type
 * with a control character is refused. Messages never contain values (SEC-3).
 */
export function multipartBody(
  fields: Readonly<Record<string, string | number | boolean>>,
  parts: readonly FilePart[],
  boundary: string,
): Uint8Array {
  const chunks: Buffer[] = [];
  const text = (s: string): void => {
    chunks.push(Buffer.from(s, 'utf8'));
  };
  for (const key of Object.keys(fields).sort()) {
    checkName(key);
    text(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(fields[key])}\r\n`);
  }
  for (const part of parts) {
    checkName(part.name);
    // eslint-disable-next-line no-control-regex -- a header value must hold no control character
    if (/[\x00-\x1f\x7f]/.test(part.mediaType)) throw new MappingError('a multipart media type is not allowed');
    text(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${quoted(part.filename)}"\r\n`);
    if (part.mediaType !== '') text(`Content-Type: ${part.mediaType}\r\n`);
    text('\r\n');
    chunks.push(Buffer.from(part.content.buffer, part.content.byteOffset, part.content.byteLength));
    text('\r\n');
  }
  text(`--${boundary}--\r\n`);
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * The text fields from a resolved `body` template: nothing when it rendered nothing, else a plain
 * object whose every value is a string, number or boolean. Anything else is a mapping failure
 * (nothing sent).
 */
export function multipartFields(rendered: unknown): Record<string, string | number | boolean> {
  if (rendered === undefined) return {};
  if (!isPlainObject(rendered)) throw new MappingError('a multipart body template must render an object');
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(rendered)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new MappingError('a multipart text field must be a string, number or boolean');
    }
    out[key] = value;
  }
  return out;
}
